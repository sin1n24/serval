/**
 * トーナメント管理システム — GASバックエンド
 *
 * 役割:
 *   - doGet: Index.html を HtmlService で配信（GASホスト型・単一HTML）
 *   - api*  : フロントから google.script.run で呼ばれるデータ入出力
 *
 * データの保存先:
 *   スプレッドシートの「Store」シートに key/json の2列で1レコード=1ドキュメントを保存する
 *   （トーナメント1セット = 1ドキュメント。CSV/JSON入出力はフロント側で整形して文字列で受け渡す）
 *
 * フロントは google.script.run が使えない場合 localStorage に自動フォールバックするため、
 * ここでの関数名・引数・戻り値の形をフロントの Backend 抽象レイヤと一致させておくこと。
 */

var STORE_SHEET = 'Store';

/**
 * 管理者トークン検証。スクリプトプロパティ ADMIN_TOKEN と照合する。
 * 未設定の場合は認可なし（移行期間の後方互換: ADMIN_TOKENが無いうちは全許可）。
 * デプロイ後にユーザーが ADMIN_TOKEN=sin1serval をスクリプトプロパティへ設定すること。
 */
function _checkAdmin_(token) {
  var t = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN');
  if (!t) return true;  // 未設定時は後方互換で許可
  return !!token && token === t;
}

/** JSON APIレスポンス（GitHub Pagesポータル等、外部からのfetch用） */
function _jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * 外部ポータル用の書き込みAPI。GitHub Pages等からのクロスオリジンfetchを想定し、
 * Content-Type: text/plain のPOSTボディ（JSON文字列）で受ける（preflight回避）。
 * body = { action, token, ...args }
 */
function doPost(e) {
  var req = {};
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return _jsonOut_({ ok: false, error: 'リクエストJSONが不正です' }); }
  var act = String(req.action || '');
  var token = req.token || '';
  if (act === 'bookList')    return _jsonOut_(apiBookList(!!req.deleted));
  if (act === 'bookCreate')  return _jsonOut_(apiBookCreate(req.name, req.page, req.docKey, token));
  if (act === 'bookUpdate')  return _jsonOut_(apiBookUpdate(req.id, JSON.stringify(req.book || {}), token));
  if (act === 'bookDelete')  return _jsonOut_(apiBookDelete(req.id, token));
  if (act === 'bookRestore') return _jsonOut_(apiBookRestore(req.id, token));
  if (act === 'deletePage')  return _jsonOut_(apiDeletePage(req.key, token));
  return _jsonOut_({ ok: false, error: '不明なaction: ' + act });
}

/** Webアプリのエントリポイント。Index.html（?portal 時は portal.html、?api= 時はJSON API）を返す。 */
function doGet(e) {
  var p0 = (e && e.parameter) || {};
  if (p0.api != null) {                                                   // ?api=booklist 読み取り専用JSON API
    var act = String(p0.api);
    if (act === 'booklist')  return _jsonOut_(apiBookList(p0.deleted != null));
    if (act === 'pagelist')  return _jsonOut_(apiPageList());
    return _jsonOut_({ ok: false, error: '不明なapi: ' + act });
  }
  if (p0.portal != null) {                                                // ?portal シリーズ管理ポータル
    var pout = HtmlService.createHtmlOutputFromFile('portal')
      .setTitle('serval ポータル')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    var pjs = '';
    try { pjs += 'window.__EXECURL__=' + JSON.stringify(ScriptApp.getService().getUrl() || '') + ';'; } catch (err) {}
    if (pjs) pout.append('<script>' + pjs + '<\/script>');
    return pout;
  }
  // index.html を配信。巨大な1つのインラインscriptはGASのHTML処理で脱落するため、JSは複数の小さな<script>に分割済み。
  var out = HtmlService.createHtmlOutputFromFile('app')
    .setTitle('トーナメント管理システム')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // 配信/呼び出しシステムからiframe埋め込み可
  // GASではアプリが googleusercontent.com のiframe内で動くため、JSからURLパラメータも
  // WebアプリのURL自体も読めない。必要な値はサーバ側で window に埋め込む。
  // （append は </html> の後ろに付くが DOMContentLoaded より先に実行されるので init から参照できる）
  var p = (e && e.parameter) || {};
  var js = '';
  try { js += 'window.__EXECURL__=' + JSON.stringify(ScriptApp.getService().getUrl() || '') + ';'; } catch (err) {}
  var doc = p.doc ? String(p.doc).slice(0, 100) : '';                    // ?doc=◯◯ 大会（保存キー）
  if (doc) js += 'window.__DOCKEY__=' + JSON.stringify(doc) + ';';
  if (p.board != null) js += 'window.__BOARD__=true;';                   // ?board 大型表示（別画面１）
  if (p.lane  != null) js += 'window.__LANE__=true;';                    // ?lane  横長バナー（別画面２）
  if (p.sub   != null) js += 'window.__SUB__=true;';                     // ?sub   大型表示（別画面３）
  if (p.admin != null) {                                                  // ?admin 管理者モード
    // view-mode解除はinit()でパスワード確認後に enterAdmin() → applyViewMode() が行う
    js += 'window.__ADMIN__=true;';
  }
  if (js) out.append('<script>' + js + '<\/script>');
  return out;
}

/** Store シートを取得（無ければ作る）。 */
function getStoreSheet_() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    // スタンドアロンスクリプト：保存先スプレッドシートは一度だけ作成し、以後はSS_IDで再利用する。
    // （毎回 create するとAPI呼び出しごとにスプレッドシートが量産され、Drive上限/レート超過で失敗する）
    var id = props.getProperty('SS_ID');
    if (id) {
      try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }  // 削除済み等は作り直す
    }
    if (!ss) {
      ss = SpreadsheetApp.create('TournamentManager-Store');
      props.setProperty('SS_ID', ss.getId());
    }
  }
  var sh = ss.getSheetByName(STORE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(STORE_SHEET);
    sh.getRange(1, 1, 1, 3).setValues([['key', 'json', 'updatedAt']]);
  }
  return sh;
}

/** 1ドキュメントを保存。key単位で上書き。 */
function apiSave(key, jsonString, token) {
  if (!_checkAdmin_(token)) return { ok: false, key: key, error: '認証エラー' };
  // スプレッドシートの1セルは最大50,000文字。超える場合は明示エラーを返す（setValuesの例外を避ける）。
  if (jsonString && jsonString.length > 49500) {
    return { ok: false, key: key,
      error: 'データが大きすぎます（' + jsonString.length + '文字 > 上限49500）。選手数やトーナメント数を減らしてください。' };
  }
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, key: key, error: 'ロック取得タイムアウト。もう一度試してください。' }; }
  try {
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var now = new Date();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === key) {
        sh.getRange(i + 1, 2, 1, 2).setValues([[jsonString, now]]);
        return { ok: true, key: key, updatedAt: now.toISOString() };
      }
    }
    sh.appendRow([key, jsonString, now]);
    return { ok: true, key: key, updatedAt: now.toISOString() };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** 1ドキュメントを読み込み。 */
function apiLoad(key) {
  var sh = getStoreSheet_();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      return { ok: true, key: key, json: data[i][1] };
    }
  }
  return { ok: false, key: key, json: null };
}

/** 保存済みドキュメントのキー一覧を返す。 */
function apiList() {
  var sh = getStoreSheet_();
  var data = sh.getDataRange().getValues();
  var keys = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    // updatedAt は生のDateを返すと google.script.run のシリアライズに失敗し
    // クライアントに null が渡る（保存/読込が文字列のみ返すのと違う）。必ず文字列化する。
    var u = data[i][2];
    var upd = (u instanceof Date) ? u.toISOString() : (u == null ? '' : String(u));
    keys.push({ key: String(data[i][0]), updatedAt: upd });
  }
  return { ok: true, keys: keys };
}

/**
 * 運用フェーズの試合結果送信。
 * payload = { tournamentId, matchId, result, time } を受け取り、
 * 現在の状態ドキュメントに反映して保存し直す想定。骨組み段階ではエコー＋保存のみ。
 */
function apiSubmitResult(key, payloadJson, token) {
  // payloadJson はフロントで反映済みの最新state全体を渡す方式にしておくと衝突が少ない。
  // 保存に成功したらOKを返し、フロントの「進むアニメーション」を発火させる。
  var r = apiSave(key, payloadJson, token);
  if (!r || !r.ok) return r || { ok: false, key: key, error: '保存に失敗しました' };  // サイズ超過等はそのまま返す
  return { ok: true, key: key, receivedAt: new Date().toISOString() };
}

/* ============================================================
 *  スポンサー広告の集計（表示回数 / クリック回数）
 *  - 本体stateとは別レコード「<key>__adstats」に保存する。
 *    閲覧者が大量に書き込んでも試合データ(state)を上書きしないため。
 *  - 形: { views: 全体閲覧数, clicks: [広告A, 広告B, 広告C, 広告D, 広告E] }
 * ============================================================ */
function _adStatsKey_(key) { return String(key || 'default') + '__adstats'; }

function _adEnsureClicks_(stats) {
  if (!Array.isArray(stats.clicks)) stats.clicks = [0,0,0,0,0,0,0,0];
  while (stats.clicks.length < 8) stats.clicks.push(0);
}

/** 広告イベントを加算。kind='view'(全体閲覧) または 'click'(index番の広告)。 */
function apiAdEvent(key, kind, index) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { /* ロック取得失敗でも続行（多少の競合は許容） */ }
  try {
    var statsKey = _adStatsKey_(key);
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var rowIdx = -1, stats = { views: 0, clicks: [0,0,0,0,0,0,0,0] };
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === statsKey) {
        rowIdx = i;
        try { var p = JSON.parse(data[i][1]); if (p) stats = p; } catch (e) {}
        break;
      }
    }
    _adEnsureClicks_(stats);
    if (kind === 'view') {
      stats.views = (stats.views || 0) + 1;
    } else if (kind === 'click') {
      var ix = Math.max(0, Math.min(7, parseInt(index, 10) || 0));
      stats.clicks[ix] = (stats.clicks[ix] || 0) + 1;
    }
    var now = new Date();
    if (rowIdx >= 0) sh.getRange(rowIdx + 1, 2, 1, 2).setValues([[JSON.stringify(stats), now]]);
    else sh.appendRow([statsKey, JSON.stringify(stats), now]);
    return { ok: true, stats: stats };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/** 広告集計を取得。 */
function apiAdStats(key) {
  var sh = getStoreSheet_();
  var data = sh.getDataRange().getValues();
  var statsKey = _adStatsKey_(key);
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === statsKey) {
      try {
        var s = JSON.parse(data[i][1]);
        _adEnsureClicks_(s);
        return { ok: true, stats: s };
      } catch (e) {}
    }
  }
  return { ok: true, stats: { views: 0, clicks: [0,0,0,0,0,0,0,0] } };
}

/** 広告集計をリセット。 */
function apiAdReset(key, token) {
  if (!_checkAdmin_(token)) return { ok: false, error: '認証エラー' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) {}
  try {
    var statsKey = _adStatsKey_(key);
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var stats = { views: 0, clicks: [0,0,0,0,0,0,0,0] };
    var now = new Date();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === statsKey) {
        sh.getRange(i + 1, 2, 1, 2).setValues([[JSON.stringify(stats), now]]);
        return { ok: true, stats: stats };
      }
    }
    sh.appendRow([statsKey, JSON.stringify(stats), now]);
    return { ok: true, stats: stats };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/* ============================================================
 *  応援ハート / 推し投票
 * ============================================================ */

/** ハートを送信（連打バッチ対応）。tsJson はタイムスタンプ配列のJSON文字列。試合別累計も記録。 */
function apiSendHeart(key, tsJson, matchKey, matchBrief) {
  var lock = LockService.getScriptLock();
  // 一斉送信時のロック競合を分散（0〜500msのランダム遅延）
  Utilities.sleep(Math.floor(Math.random() * 500));
  var locked = false;
  try { lock.waitLock(4000); locked = true; } catch (e) {}
  if (!locked) return { ok: false };
  try {
    var hkey = String(key || '') + '__hearts';
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var rowIdx = -1, obj = { ts: [], byMatch: {} };
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === hkey) { rowIdx = i; try { obj = JSON.parse(data[i][1]); } catch (e) {} break; }
    }
    var now = Date.now();
    if (!Array.isArray(obj.ts)) obj.ts = [];
    if (!obj.byMatch) obj.byMatch = {};
    // タイムスタンプ配列を受け取る（旧形式の数値countにも後方互換）
    var tsList;
    try { tsList = JSON.parse(tsJson); } catch (e) { tsList = null; }
    if (!Array.isArray(tsList)) tsList = [now]; // fallback
    tsList = tsList.slice(0, 30); // 最大30件
    for (var k = 0; k < tsList.length; k++) obj.ts.push(Number(tsList[k]) || now);
    obj.ts = obj.ts.filter(function (t) { return now - t < 120000; }); // 直近2分のみ保持
    // 試合別累計（pruneしない）
    if (matchKey) {
      var mk = String(matchKey).slice(0, 20);
      if (!obj.byMatch[mk]) obj.byMatch[mk] = { cnt: 0, brief: String(matchBrief || mk).slice(0, 60) };
      obj.byMatch[mk].cnt += tsList.length;
    }
    var nowDate = new Date();
    if (rowIdx >= 0) sh.getRange(rowIdx + 1, 2, 1, 2).setValues([[JSON.stringify(obj), nowDate]]);
    else sh.appendRow([hkey, JSON.stringify(obj), nowDate]);
    return { ok: true };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/** since より後のタイムスタンプ一覧と試合別応援集計を返す。 */
function apiGetHearts(key, since) {
  var hkey = String(key || '') + '__hearts';
  var sh = getStoreSheet_();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === hkey) {
      try {
        var obj = JSON.parse(data[i][1]);
        var items = (obj.ts || []).filter(function (t) { return t > (since || 0); });
        return { ok: true, items: items, byMatch: obj.byMatch || {} };
      } catch (e) {}
    }
  }
  return { ok: true, items: [], byMatch: {} };
}

/** 推し投票: playerName に1票追加して累計を返す。 */
function apiAddVote(key, playerName) {
  if (!playerName) return { ok: false };
  var lock = LockService.getScriptLock();
  // 一斉タップ時のロック競合を分散（0〜1秒のランダム遅延）
  Utilities.sleep(Math.floor(Math.random() * 1000));
  var locked = false;
  try { lock.waitLock(5000); locked = true; } catch (e) {}
  if (!locked) return { ok: false };
  try {
    var vkey = String(key || '') + '__votes';
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var rowIdx = -1, votes = {};
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === vkey) { rowIdx = i; try { votes = JSON.parse(data[i][1]); } catch (e) {} break; }
    }
    votes[playerName] = (votes[playerName] || 0) + 1;
    var now = new Date();
    if (rowIdx >= 0) sh.getRange(rowIdx + 1, 2, 1, 2).setValues([[JSON.stringify(votes), now]]);
    else sh.appendRow([vkey, JSON.stringify(votes), now]);
    return { ok: true, count: votes[playerName] };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/** 投票ランキング（全件）を返す。 */
function apiGetVotes(key) {
  var vkey = String(key || '') + '__votes';
  var sh = getStoreSheet_();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === vkey) {
      try { return { ok: true, votes: JSON.parse(data[i][1]) }; } catch (e) {}
    }
  }
  return { ok: true, votes: {} };
}

/* ============================================================
 *  ブック（1大会=1GASプロジェクト）のメタレコード
 *  - key: __book__<id> で Store シートに保存。
 *  - { id, name, page, url, note, deleted, createdAt, updatedAt }
 *    page: ブック内のページ番号（例: JimaCup の 7ページ目 → page:7）
 *  - 削除はソフトデリート（deleted:true）。ポータル一覧から消えるだけでデータは残る。
 * ============================================================ */
var BOOK_PREFIX = '__book__';

function _bookKey_(id) { return BOOK_PREFIX + String(id); }

/** ブックID発行（日付+乱数） */
function _newBookId_() {
  var d = new Date();
  var ymd = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
  return 'b' + ymd + '_' + Math.random().toString(36).slice(2, 8);
}

/** Storeシートからブック行を探す。{ rowIdx, obj } を返す。無ければ null。 */
function _findBook_(sh, id) {
  var key = _bookKey_(id);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      var obj = null;
      try { obj = JSON.parse(data[i][1]); } catch (e) {}
      return { rowIdx: i, obj: obj };
    }
  }
  return null;
}

/** ブック一覧。deleted:true は includeDeleted 指定時のみ含める。 */
function apiBookList(includeDeleted) {
  var sh = getStoreSheet_();
  var data = sh.getDataRange().getValues();
  var list = [];
  for (var i = 1; i < data.length; i++) {
    var k = String(data[i][0] || '');
    if (k.indexOf(BOOK_PREFIX) !== 0) continue;
    var obj = null;
    try { obj = JSON.parse(data[i][1]); } catch (e) { continue; }
    if (!obj) continue;
    if (obj.deleted && !includeDeleted) continue;
    list.push(obj);
  }
  // 更新日時の新しい順
  list.sort(function (a, b) { return String(b.updatedAt || '') < String(a.updatedAt || '') ? -1 : 1; });
  return { ok: true, books: list };
}

/** ブック1件取得。 */
function apiBookGet(id) {
  var found = _findBook_(getStoreSheet_(), id);
  if (!found || !found.obj) return { ok: false, error: 'ブックが見つかりません: ' + id };
  return { ok: true, book: found.obj };
}

/** ブック新規作成。name 必須、page・docKey は任意。 */
function apiBookCreate(name, page, docKey, token) {
  if (!_checkAdmin_(token)) return { ok: false, error: '認証エラー' };
  if (!name) return { ok: false, error: 'ブック名を指定してください' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: 'ロック取得タイムアウト' }; }
  try {
    var sh = getStoreSheet_();
    var id = _newBookId_();
    while (_findBook_(sh, id)) id = _newBookId_();
    var now = new Date().toISOString();
    var pg = (page !== undefined && page !== null && page !== '') ? Number(page) : null;
    var dk = docKey ? String(docKey).slice(0, 100) : '';
    var obj = { id: id, name: String(name).slice(0, 100), page: pg, docKey: dk, url: '', note: '', deleted: false, createdAt: now, updatedAt: now };
    sh.appendRow([_bookKey_(id), JSON.stringify(obj), new Date()]);
    return { ok: true, book: obj };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/**
 * ブック更新。jsonString はブックオブジェクト全体。
 * id と createdAt はサーバ側で保持し、updatedAt を更新する。
 */
function apiBookUpdate(id, jsonString, token) {
  if (!_checkAdmin_(token)) return { ok: false, error: '認証エラー' };
  if (jsonString && jsonString.length > 49500) {
    return { ok: false, error: 'ブックデータが大きすぎます（' + jsonString.length + '文字 > 上限49500）' };
  }
  var incoming = null;
  try { incoming = JSON.parse(jsonString); } catch (e) { return { ok: false, error: 'JSONが不正です' }; }
  if (!incoming || typeof incoming !== 'object') return { ok: false, error: 'JSONが不正です' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: 'ロック取得タイムアウト' }; }
  try {
    var sh = getStoreSheet_();
    var found = _findBook_(sh, id);
    if (!found) return { ok: false, error: 'ブックが見つかりません: ' + id };
    incoming.id = id;
    if (found.obj && found.obj.createdAt) incoming.createdAt = found.obj.createdAt;
    incoming.updatedAt = new Date().toISOString();
    sh.getRange(found.rowIdx + 1, 2, 1, 2).setValues([[JSON.stringify(incoming), new Date()]]);
    return { ok: true, book: incoming };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/** ソフトデリート。 */
function apiBookDelete(id, token) { return _bookSetDeleted_(id, true, token); }

/** 復元。 */
function apiBookRestore(id, token) { return _bookSetDeleted_(id, false, token); }

function _bookSetDeleted_(id, deleted, token) {
  if (!_checkAdmin_(token)) return { ok: false, error: '認証エラー' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: 'ロック取得タイムアウト' }; }
  try {
    var sh = getStoreSheet_();
    var found = _findBook_(sh, id);
    if (!found || !found.obj) return { ok: false, error: 'ブックが見つかりません: ' + id };
    found.obj.deleted = !!deleted;
    found.obj.updatedAt = new Date().toISOString();
    sh.getRange(found.rowIdx + 1, 2, 1, 2).setValues([[JSON.stringify(found.obj), new Date()]]);
    return { ok: true, book: found.obj };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/* ============================================================
 *  ページ（トーナメントデータ）の管理
 *  - Storeシートに key = pageキー（例: JimaCup7）で保存された実データを操作する。
 *  - __book__ / __series__ / __adstats / __hearts / __votes サフィックスを除いた行がページ。
 * ============================================================ */

/** ページキー一覧（メタキーを除いた通常データキー）を返す。 */
function apiPageList() {
  var sh = getStoreSheet_();
  var data = sh.getDataRange().getValues();
  var keys = [];
  for (var i = 1; i < data.length; i++) {
    var k = String(data[i][0] || '');
    if (!k) continue;
    if (k.indexOf('__') === 0) continue;           // __book__, __series__ 等を除外
    if (k.indexOf('__') >= 0) continue;            // xxxx__hearts 等サフィックス付きを除外
    var u = data[i][2];
    var upd = (u instanceof Date) ? u.toISOString() : (u == null ? '' : String(u));
    keys.push({ key: k, updatedAt: upd });
  }
  return { ok: true, pages: keys };
}

/** 指定キーの行を Storeシートから削除する。 */
function apiDeletePage(key, token) {
  if (!_checkAdmin_(token)) return { ok: false, error: '認証エラー' };
  if (!key) return { ok: false, error: 'keyを指定してください' };
  var k = String(key);
  // 安全装置: __book__ 等メタキーは削除させない
  if (k.indexOf('__') === 0 || k.indexOf('__') >= 0) {
    return { ok: false, error: 'メタキーは削除できません: ' + k };
  }
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: 'ロック取得タイムアウト' }; }
  try {
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === k) {
        sh.deleteRow(i + 1);
        return { ok: true, key: k };
      }
    }
    return { ok: false, error: 'キーが見つかりません: ' + k };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}
