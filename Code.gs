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

/** Webアプリのエントリポイント。Index.html を返す。 */
function doGet(e) {
  // index.html を配信。巨大な1つのインラインscriptはGASのHTML処理で脱落するため、JSは複数の小さな<script>に分割済み。
  var out = HtmlService.createHtmlOutputFromFile('index')
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
  if (p.board != null) js += 'window.__BOARD__=true;';                   // ?board 大型表示（別画面）
  if (p.admin != null) {                                                  // ?admin 管理者モード
    // 早期FOUC対策スクリプト（body直後）はiframe内でURLを読めないため、ここでview-mode解除も行う
    js += 'window.__ADMIN__=true;try{document.body.classList.remove("view-mode")}catch(err){}';
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
function apiSave(key, jsonString) {
  // スプレッドシートの1セルは最大50,000文字。超える場合は明示エラーを返す（setValuesの例外を避ける）。
  if (jsonString && jsonString.length > 49500) {
    return { ok: false, key: key,
      error: 'データが大きすぎます（' + jsonString.length + '文字 > 上限49500）。選手数やトーナメント数を減らしてください。' };
  }
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
    if (data[i][0]) keys.push({ key: data[i][0], updatedAt: data[i][2] });
  }
  return { ok: true, keys: keys };
}

/**
 * 運用フェーズの試合結果送信。
 * payload = { tournamentId, matchId, result, time } を受け取り、
 * 現在の状態ドキュメントに反映して保存し直す想定。骨組み段階ではエコー＋保存のみ。
 */
function apiSubmitResult(key, payloadJson) {
  // payloadJson はフロントで反映済みの最新state全体を渡す方式にしておくと衝突が少ない。
  // 保存に成功したらOKを返し、フロントの「進むアニメーション」を発火させる。
  var r = apiSave(key, payloadJson);
  if (!r || !r.ok) return r || { ok: false, key: key, error: '保存に失敗しました' };  // サイズ超過等はそのまま返す
  return { ok: true, key: key, receivedAt: new Date().toISOString() };
}

/* ============================================================
 *  スポンサー広告の集計（表示回数 / クリック回数）
 *  - 本体stateとは別レコード「<key>__adstats」に保存する。
 *    閲覧者が大量に書き込んでも試合データ(state)を上書きしないため。
 *  - 形: { views: 全体閲覧数, clicks: [広告1, 広告2, 広告3] }
 * ============================================================ */
function _adStatsKey_(key) { return String(key || 'default') + '__adstats'; }

/** 広告イベントを加算。kind='view'(全体閲覧) または 'click'(index番の広告)。 */
function apiAdEvent(key, kind, index) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { /* ロック取得失敗でも続行（多少の競合は許容） */ }
  try {
    var statsKey = _adStatsKey_(key);
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var rowIdx = -1, stats = { views: 0, clicks: [0, 0, 0] };
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === statsKey) {
        rowIdx = i;
        try { var p = JSON.parse(data[i][1]); if (p) stats = p; } catch (e) {}
        break;
      }
    }
    if (!stats.clicks) stats.clicks = [0, 0, 0];
    if (kind === 'view') {
      stats.views = (stats.views || 0) + 1;
    } else if (kind === 'click') {
      var ix = Math.max(0, Math.min(2, parseInt(index, 10) || 0));
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
      try { return { ok: true, stats: JSON.parse(data[i][1]) }; } catch (e) {}
    }
  }
  return { ok: true, stats: { views: 0, clicks: [0, 0, 0] } };
}
