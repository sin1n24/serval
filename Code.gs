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
  if (act === 'dataLoad')    return _jsonOut_(apiLoad(req.key));
  if (act === 'dataSave')    return _jsonOut_(apiSave(req.key, req.json, token));
  if (act === 'bookList')    return _jsonOut_(apiBookList(!!req.deleted));
  if (act === 'bookCreate')  return _jsonOut_(apiBookCreate(req.name, token));
  if (act === 'bookUpdate')  return _jsonOut_(apiBookUpdate(req.id, JSON.stringify(req.book || {}), token));
  if (act === 'bookDelete')  return _jsonOut_(apiBookDelete(req.id, token));
  if (act === 'bookRestore') return _jsonOut_(apiBookRestore(req.id, token));
  if (act === 'deletePage')  return _jsonOut_(apiDeletePage(req.key, token));
  if (act === 'postMatchEvent') return _jsonOut_(apiPostMatchEvent(req.docKey, JSON.stringify(req.event || {}), token));
  if (act === 'registerSeeding') return _jsonOut_(apiRegisterSeeding(req.docKey, JSON.stringify(req.seeding || {}), token));
  if (act === 'ping')            return _jsonOut_(apiPing(token));
  if (act === 'clearIdemForMatch') return _jsonOut_(apiClearIdemForMatch(req.docKey, req.matchKey, token));
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
  if (p0.result != null) {                                                // ?result 大会成績CSV出力
    var rDoc = p0.doc ? String(p0.doc).slice(0, 100) : 'default';
    return apiExportResultsCsv_(rDoc);
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
  if (p.meter != null) js += 'window.__METER__=true;';                   // ?meter WinMeter評価バー（別画面４）
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

/**
 * ?result&doc=<docKey> で参加ロボットの大会成績一覧をCSVとして返す（?board等と同じURLパラメータ方式）。
 * 修理時間など試合ごとの細かい情報は含めない。単独トーナメント（代表戦・リーグ戦は非対応）が対象。
 */
function apiExportResultsCsv_(docKey) {
  var loaded = apiLoad(docKey);
  if (!loaded.ok || !loaded.json) {
    return ContentService.createTextOutput('該当データが見つかりません: ' + docKey).setMimeType(ContentService.MimeType.TEXT);
  }
  var state;
  try { state = JSON.parse(loaded.json); } catch (e) {
    return ContentService.createTextOutput('データの読み込みに失敗しました').setMimeType(ContentService.MimeType.TEXT);
  }
  var rows = _buildResultsRows_(state);
  var header = ['番号','ロボット名','フリガナ','操縦者名','所属','所属フリガナ','タイプ1','タイプ2','一言紹介',
                '大会成績','勝ち試合数','負け試合数','勝ち本数','負け本数'];
  var lines = [_csvRow_(header)];
  rows.forEach(function (r) {
    lines.push(_csvRow_([r.number, r.playerName, r.furigana, r.representative, r.affiliation, r.affiliationFurigana,
      r.type1, r.type2, r.intro, r.placement, r.winMatches, r.loseMatches, r.winGames, r.loseGames]));
  });
  // Excel等での文字化け防止にBOM付きUTF-8で返す
  return ContentService.createTextOutput('﻿' + lines.join('\r\n')).setMimeType(ContentService.MimeType.CSV);
}

function _csvRow_(arr) {
  return arr.map(function (v) {
    var s = (v == null) ? '' : String(v);
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

/**
 * 代表トーナメント（state.repT、複数ブロック時のみ）を辿り、優勝/準優勝/3位/4位が
 * それぞれどのトーナメント（ブロック）index（tournaments配列の添字）に属するかを返す。
 * repT.slots[i] は tournaments[i] の代表と対応する（syncRepTournament()の構築順）。
 * 戻り値: { champIdx, runnerUpIdx, thirdIdx, fourthIdx }（決着していない項目はnull）。
 * 代表戦が無い（単独大会）・代表リーグ戦モードの場合は全項目null。
 */
function _repPlacementIdxs_(state) {
  var none = { champIdx: null, runnerUpIdx: null, thirdIdx: null, fourthIdx: null };
  var tn = (state && state.tournaments) || [];
  var cnt = tn.length;
  if (cnt <= 1) return none;
  if (state.config && state.config.repMode === 'league' && cnt === 3) return none;  // 代表リーグ戦は非対応（順位表は別ロジックが必要）
  var rt = state.repT;
  if (!rt || !rt.results) return none;
  var repSize = cnt <= 2 ? 2 : 4;
  var rounds = Math.log2(repSize);
  function hasComp(r, j) {
    if (r === 0) return j < cnt;
    return hasComp(r - 1, 2 * j) || hasComp(r - 1, 2 * j + 1);
  }
  function occ(r, j) {
    if (r === 0) return j < cnt ? j : null;
    var h0 = hasComp(r - 1, 2 * j), h1 = hasComp(r - 1, 2 * j + 1);
    if (!h0 && !h1) return null;
    if (h0 && !h1) return occ(r - 1, 2 * j);
    if (!h0 && h1) return occ(r - 1, 2 * j + 1);
    var c0 = occ(r - 1, 2 * j), c1 = occ(r - 1, 2 * j + 1);
    if (c0 == null || c1 == null) return null;
    var res = rt.results[r + '-' + j];
    if (!res || res.win == null || res.kind === '勝者なし') return null;
    return res.win === 0 ? c0 : c1;
  }
  if (repSize === 2) {
    var champ2 = occ(1, 0);
    if (champ2 == null) return none;
    var runner2 = occ(0, champ2 === 0 ? 1 : 0);
    // 2ブロック構成の3位決定戦（config.repThird時）：各ブロック自身の決勝敗者（ブロックrunner-up）同士の別試合。
    // thirdRunnerUpBlockIdx はそのうち勝った側のトーナメントindex（0=tournaments[0]側のrunner-upが3位）。
    // これが有効な間は、ブロックのrunner-up全員が代表3位決定戦の当事者になる（＝本来の「ベスト8」相当が
    // 存在しなくなる）ため、3位決定戦敗者は4ブロック方式と同じ「ベスト4」に、その下の「各ブロック準決勝
    // 敗者」は1段繰り上げて「ベスト8」と表記する（_buildResultsRows_側で分岐）。
    var thirdRunnerUpBlockIdx = null;
    var res3b = rt.results['3rd'];
    if (res3b && res3b.win != null && res3b.kind !== '勝者なし') thirdRunnerUpBlockIdx = res3b.win;
    var thirdEnabled2 = !!(state.config && state.config.repThird);
    return { champIdx: champ2, runnerUpIdx: runner2, thirdIdx: null, fourthIdx: null,
             thirdRunnerUpBlockIdx: thirdRunnerUpBlockIdx, thirdEnabled2: thirdEnabled2 };
  }
  // repSize===4: 準決勝(r=1: j=0が0v1, j=1が2v3) → 決勝(r=2:j=0)。3位決定戦は rt.results['3rd']（あれば）。
  var semiLoser = [null, null];
  var semiRes0 = rt.results['1-0'], semiRes1 = rt.results['1-1'];
  if (semiRes0 && semiRes0.win != null && semiRes0.kind !== '勝者なし') semiLoser[0] = (semiRes0.win === 0) ? 1 : 0;
  if (semiRes1 && semiRes1.win != null && semiRes1.kind !== '勝者なし') semiLoser[1] = (semiRes1.win === 0) ? 3 : 2;
  var champIdx = occ(2, 0);
  var runnerUpIdx = null;
  if (champIdx != null) {
    var w0 = occ(1, 0), w1 = occ(1, 1);
    runnerUpIdx = (champIdx === w0) ? w1 : w0;
  }
  var thirdIdx = null, fourthIdx = null;
  var res3 = rt.results['3rd'];
  if (res3 && res3.win != null && res3.kind !== '勝者なし' && semiLoser[0] != null && semiLoser[1] != null) {
    thirdIdx = (res3.win === 0) ? semiLoser[0] : semiLoser[1];
    fourthIdx = (res3.win === 0) ? semiLoser[1] : semiLoser[0];
  }
  return { champIdx: champIdx, runnerUpIdx: runnerUpIdx, thirdIdx: thirdIdx, fourthIdx: fourthIdx,
           semiLoserIdxs: [semiLoser[0], semiLoser[1]] };
}

/**
 * 各トーナメントの出場ロボットについて、勝敗数・大会成績（優勝/準優勝/3位/ベストN）を集計する。
 * 複数ブロック＋代表トーナメントがある場合（例: 中島杯のブロックA〜D→代表決勝）は、
 * 「ブロックごとの優勝」をそのまま優勝表記すると全体で複数名が優勝になってしまうため、
 * ブロックを無視した全体成績として付け直す:
 *   優勝/準優勝/3位＝代表戦（state.repT）の結果そのもの。
 *   代表戦で3位決定戦に敗れた1名（またはそもそも3位決定戦が無い場合の準決勝敗者2名）＝ベスト4。
 *   各ブロック決勝の敗者（ブロック代表次点、計4名）＝ベスト8。
 *   各ブロック準決勝の敗者（計8名）＝ベスト16。
 * それより浅いラウンドの敗退（ブロック内でしか対戦していない層）は、従来通りブロック内の
 * 実際の対戦人数を基準にした「ベストN」表記のまま据え置く（ブロックを跨いだ比較ができないため）。
 */
function _buildResultsRows_(state) {
  var out = [];
  var tournaments = (state && state.tournaments) || [];
  var multi = tournaments.length > 1;
  var rp = multi ? _repPlacementIdxs_(state) : null;

  // ---- パス1: 各ブロックの勝敗・占有者(occ)・実対戦人数(activeCounts)を集計する（ラベルはまだ付けない） ----
  var blocks = tournaments.map(function (t) {
    var size = t.size, rounds = Math.log2(size);
    var slots = t.slots || [];
    var results = t.results || {};
    var stat = slots.map(function () { return { winMatches: 0, loseMatches: 0, winGames: 0, loseGames: 0, placement: null }; });
    var occ = [];
    // シード/不戦（バイ）で空きスロットは非在籍(null)として扱う。実在の選手のみ勝ち上がり計算に含める。
    occ[0] = slots.map(function (s, i) {
      var p = s && s.player;
      return (p && (p.playerName || p.number)) ? i : null;
    });
    var activeCounts = [occ[0].filter(function (x) { return x != null; }).length];
    var matchLoser = {};   // 'r-j' -> 敗者の元スロット番号
    var loserByRound = {}; // r -> [敗者の元スロット番号,...]（r===roundsは除く。ラベルはパス2で付ける）
    var champOrigin = null, runnerUpOrigin = null;

    for (var r = 1; r <= rounds; r++) {
      occ[r] = [];
      var prevLen = occ[r - 1].length;
      for (var j = 0; j * 2 < prevLen; j++) {
        var aOrig = occ[r - 1][2 * j];
        var bOrig = (2 * j + 1 < prevLen) ? occ[r - 1][2 * j + 1] : null;
        if (aOrig == null && bOrig == null) { occ[r][j] = null; continue; }
        if (aOrig == null) { occ[r][j] = bOrig; continue; }       // 片方不戦（シード）は自動勝ち上がり
        if (bOrig == null) { occ[r][j] = aOrig; continue; }
        var res = results[r + '-' + j];
        if (!res || res.win == null || res.kind === '勝者なし') { occ[r][j] = null; continue; }  // 未決着
        var winOrig = (res.win === 0) ? aOrig : bOrig;
        var loseOrig = (res.win === 0) ? bOrig : aOrig;
        occ[r][j] = winOrig;
        matchLoser[r + '-' + j] = loseOrig;
        _applyMatchStat_(stat, res, winOrig, loseOrig);
        if (r === rounds) {
          champOrigin = winOrig; runnerUpOrigin = loseOrig;
        } else if (loseOrig != null) {
          (loserByRound[r] = loserByRound[r] || []).push(loseOrig);
        }
      }
      activeCounts[r] = occ[r].filter(function (x) { return x != null; }).length;
    }
    return { t: t, rounds: rounds, slots: slots, results: results, stat: stat, activeCounts: activeCounts,
             matchLoser: matchLoser, loserByRound: loserByRound, champOrigin: champOrigin, runnerUpOrigin: runnerUpOrigin };
  });

  // ---- パス2: ラベルを確定させる ----
  // 複数ブロック時は「ブロックは無視して全体のベストN」にし、ベスト16までで打ち止めにする
  // （優勝/準優勝/3位/ベスト4＝代表戦、ベスト8＝各ブロック代表次点、ベスト16＝各ブロック準決勝敗者）。
  // それより浅いラウンド（ブロック内でしか対戦していない層）はラベルを付けない（空欄のまま）。
  blocks.forEach(function (b, tIdx) {
    var rounds = b.rounds, stat = b.stat, matchLoser = b.matchLoser, loserByRound = b.loserByRound;
    var champOrigin = b.champOrigin, runnerUpOrigin = b.runnerUpOrigin;
    Object.keys(loserByRound).forEach(function (rKey) {
      var r = +rKey;
      if (multi) {
        if (rp && rp.thirdEnabled2) {
          // 2ブロック構成＋代表3位決定戦あり：各ブロック決勝(runner-up同士の3位決定戦を経て順位が
          // 決まる)自体が実質的に代表決定の一部となるため、その下の階層も1段深い方向にシフトする
          // （旧ベスト16＝ブロック準決勝敗者→ベスト8、旧・空欄＝ブロック準々決勝敗者→ベスト16）。
          if (r === rounds - 1) {
            loserByRound[r].forEach(function (origin) { if (stat[origin].placement == null) stat[origin].placement = 'ベスト8'; });
          } else if (r === rounds - 2) {
            loserByRound[r].forEach(function (origin) { if (stat[origin].placement == null) stat[origin].placement = 'ベスト16'; });
          }
          return;
        }
        if (r !== rounds - 1) return;   // ブロック準決勝(ベスト16)以外の浅いラウンドは空欄のまま
        loserByRound[r].forEach(function (origin) { if (stat[origin].placement == null) stat[origin].placement = 'ベスト16'; });
        return;
      }
      var label = 'ベスト' + b.activeCounts[r - 1];
      loserByRound[r].forEach(function (origin) { if (stat[origin].placement == null) stat[origin].placement = label; });
    });
    if (!multi) {
      if (champOrigin != null) stat[champOrigin].placement = '優勝';
      if (runnerUpOrigin != null) stat[runnerUpOrigin].placement = '準優勝';
      // 単独大会：3位決定戦は準決勝の2試合の敗者どうし
      var sf = rounds - 1;
      var loserA = matchLoser[sf + '-0'], loserB = matchLoser[sf + '-1'];
      var res3 = b.results['3rd'];
      if (res3 && res3.win != null && (loserA != null || loserB != null)) {
        var win3 = (res3.win === 0) ? loserA : loserB;
        var lose3 = (res3.win === 0) ? loserB : loserA;
        if (win3 != null) stat[win3].placement = '3位';
        if (lose3 != null) stat[lose3].placement = '4位';
        _applyMatchStat_(stat, res3, win3, lose3);
      }
    } else {
      // 複数ブロック：代表戦（rp）の結果に基づき、ブロックを跨いだ全体成績で振り分ける。
      // ブロック決勝の敗者（ブロック代表次点）は一律「ベスト8」——ただし2ブロック構成で
      // クロスブロック3位決定戦（rp.thirdEnabled2）が有効な場合は、rp.thirdRunnerUpBlockIdxに
      // 勝った側が「3位」、負けた側は代表戦の一部として敗れたとみなし4ブロック方式と同じ「ベスト4」にする
      // （この場合ブロックrunner-up全員が3位決定戦の当事者になるため、通常の「ベスト8」層は存在しない）。
      if (champOrigin != null) {
        if (rp && tIdx === rp.champIdx) stat[champOrigin].placement = '優勝';
        else if (rp && tIdx === rp.runnerUpIdx) stat[champOrigin].placement = '準優勝';
        else if (rp && tIdx === rp.thirdIdx) stat[champOrigin].placement = '3位';
        else stat[champOrigin].placement = 'ベスト4';   // 4位（代表戦準決勝敗退）または代表戦未決着
      }
      if (runnerUpOrigin != null) {
        if (rp && rp.thirdEnabled2) {
          stat[runnerUpOrigin].placement = (rp.thirdRunnerUpBlockIdx === tIdx) ? '3位' : 'ベスト4';
        } else {
          stat[runnerUpOrigin].placement = 'ベスト8';
        }
      }
    }

    b.slots.forEach(function (slot, i) {
      var p = slot && slot.player; if (!p || (!p.playerName && !p.number)) return;
      var s = stat[i];
      out.push({
        number: p.number || '', playerName: p.playerName || '', furigana: p.furigana || '',
        representative: p.representative || '', affiliation: p.affiliation || '',
        affiliationFurigana: p.affiliationFurigana || '', type1: p.type1 || '', type2: p.type2 || '', intro: p.intro || '',
        placement: s.placement || '', winMatches: s.winMatches, loseMatches: s.loseMatches,
        winGames: s.winGames, loseGames: s.loseGames
      });
    });
  });
  return out;
}

/** 1試合ぶんの勝敗数・本数を両者の集計に加算する。kindの数字は常に[勝者の本数]-[敗者の本数]。 */
function _applyMatchStat_(stat, res, winOrig, loseOrig) {
  if (winOrig == null || loseOrig == null) return;
  var wGames = 0, lGames = 0;
  var m = res.kind && String(res.kind).match(/^(\d+)-(\d+)勝ち$/);
  if (m) { wGames = +m[1]; lGames = +m[2]; }
  else if (res.kind === '1-1') { wGames = 1; lGames = 1; }
  // 不戦勝等はスコア0-0のまま（試合数のみカウント）
  stat[winOrig].winMatches++; stat[winOrig].winGames += wGames;
  stat[loseOrig].loseMatches++; stat[loseOrig].loseGames += lGames;
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

/** バナー画像をサーバー経由で取得しdata URLで返す（動画書き出し・Xシェア用）。
 *  ブラウザ直読みだとCORS未対応のリダイレクト(github.io→独自ドメイン等)でcanvasが
 *  汚染されるため、CORS制約のないUrlFetchAppで取得する。 */
function apiProxyImage(url) {
  try {
    url = String(url || '');
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'http(s)のみ対応' };
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return { ok: false, error: 'HTTP ' + resp.getResponseCode() };
    var blob = resp.getBlob();
    var bytes = blob.getBytes();
    if (bytes.length > 3 * 1024 * 1024) return { ok: false, error: '画像が大きすぎます(3MB超)' };
    var mime = blob.getContentType() || 'image/png';
    return { ok: true, dataUrl: 'data:' + mime + ';base64,' + Utilities.base64Encode(bytes) };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
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

/** 推し投票の取り消し: playerName の票を1つ減らす（0未満にはしない。0になったらキーごと削除）。 */
function apiRemoveVote(key, playerName) {
  if (!playerName) return { ok: false };
  var lock = LockService.getScriptLock();
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
    if (rowIdx < 0) return { ok: true, count: 0 };
    var cur = votes[playerName] || 0;
    var next = Math.max(0, cur - 1);
    if (next <= 0) delete votes[playerName]; else votes[playerName] = next;
    var now = new Date();
    sh.getRange(rowIdx + 1, 2, 1, 2).setValues([[JSON.stringify(votes), now]]);
    return { ok: true, count: next };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/**
 * 一言応援コメントの保存/更新/削除（投票者ごとの匿名ID単位）。
 * key = "<docKey>__votecomments" に { playerName: { voterId: {text, ts} } } を保存する。
 * text が空文字なら該当voterIdのエントリを削除する（＝取り消し）。
 * 誰が投票したかは追わない（voterIdはブラウザ側で生成されたランダム値）ため、
 * 個人特定はできないが、同じvoterIdからの再送は上書きになる。
 */
function apiSetVoteComment(key, playerName, voterId, text) {
  if (!playerName || !voterId) return { ok: false };
  var lock = LockService.getScriptLock();
  Utilities.sleep(Math.floor(Math.random() * 1000));
  var locked = false;
  try { lock.waitLock(5000); locked = true; } catch (e) {}
  if (!locked) return { ok: false };
  try {
    var ckey = String(key || '') + '__votecomments';
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var rowIdx = -1, all = {};
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === ckey) { rowIdx = i; try { all = JSON.parse(data[i][1]); } catch (e) {} break; }
    }
    var forPlayer = all[playerName] || {};
    var t = String(text || '').slice(0, 32);
    if (t) forPlayer[voterId] = { text: t, ts: Date.now() };
    else delete forPlayer[voterId];
    if (Object.keys(forPlayer).length) all[playerName] = forPlayer;
    else delete all[playerName];
    var now = new Date();
    if (rowIdx >= 0) sh.getRange(rowIdx + 1, 2, 1, 2).setValues([[JSON.stringify(all), now]]);
    else sh.appendRow([ckey, JSON.stringify(all), now]);
    return { ok: true };
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

/** ブック新規作成。name 必須。tournaments は後から bookUpdate で追加する。 */
function apiBookCreate(name, token) {
  if (!_checkAdmin_(token)) return { ok: false, error: '認証エラー' };
  if (!name) return { ok: false, error: 'ブック名を指定してください' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: 'ロック取得タイムアウト' }; }
  try {
    var sh = getStoreSheet_();
    var id = _newBookId_();
    while (_findBook_(sh, id)) id = _newBookId_();
    var now = new Date().toISOString();
    var obj = { id: id, name: String(name).slice(0, 100), url: '', note: '', tournaments: [], deleted: false, createdAt: now, updatedAt: now };
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

/* ============================================================
 *  Excel連携：試合結果の受信箱（フェーズ1・31回大会決勝トーナメント用）
 *  - Storeシートに key = "<docKey>__mqueue" で追記型のイベントログを保存する。
 *  - レコード形: { nextSeq, events:[{seq,type,matchKey,winnerNumber,loserNumber,
 *                  winnerScore,loserScore,idemKey,receivedAt}], seenIdem:{idemKey:true,...} }
 *  - 冪等性: idemKeyが既知なら追記せずok:trueを返す（Excel側Worksheet_Changeの多重発火対策）。
 * ============================================================ */

function _mqueueKey_(docKey) { return String(docKey || 'default') + '__mqueue'; }

/**
 * Excel/審判デバイス等の書き込み専用トークン検証。
 * ADMIN_TOKENと異なり未設定時は拒否（fail closed）。デプロイ後にスクリプトプロパティ
 * EXCEL_WRITE_TOKEN を設定して初めて書き込みを受け付ける。
 */
function _checkWriter_(token) {
  var t = PropertiesService.getScriptProperties().getProperty('EXCEL_WRITE_TOKEN');
  if (!t) return false;
  return !!token && token === t;
}

/** 疎通確認専用。Storeシートに一切触れず、通信経路とトークンの有効性だけを確認する。 */
function apiPing(token) {
  return { ok: true, authOk: _checkWriter_(token), ts: new Date().toISOString() };
}

/** 受信箱レコードを取得。無ければ空の箱を返す（rowIdxは-1）。 */
function _loadMQueue_(data, key) {
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      var obj = { nextSeq: 1, events: [], seenIdem: {} };
      try { var p = JSON.parse(data[i][1]); if (p) obj = p; } catch (e) {}
      if (!obj.events) obj.events = [];
      if (!obj.seenIdem) obj.seenIdem = {};
      if (!obj.nextSeq) obj.nextSeq = 1;
      return { rowIdx: i, obj: obj };
    }
  }
  return { rowIdx: -1, obj: { nextSeq: 1, events: [], seenIdem: {} } };
}

/** 受信箱レコードを保存（既存行があれば上書き、無ければ追加）。 */
function _saveMQueue_(sh, rowIdx, key, obj) {
  var now = new Date();
  if (rowIdx >= 0) sh.getRange(rowIdx + 1, 2, 1, 2).setValues([[JSON.stringify(obj), now]]);
  else sh.appendRow([key, JSON.stringify(obj), now]);
}

/**
 * Excel/審判デバイス等から試合イベントを受信箱へ追記する（書き込み専用トークンで保護）。
 * eventJson = {type:'match_start'|'match_result', matchKey, winnerNumber, loserNumber,
 *              winnerScore, loserScore, idemKey}
 * matchKeyはservalの openMatchByKey と同じコロン記法（例 "1:2:1"、3位決定戦は "1:3rd"）。
 */
function apiPostMatchEvent(docKey, eventJson, token) {
  if (!_checkWriter_(token)) return { ok: false, error: '認証エラー' };
  var ev;
  try { ev = JSON.parse(eventJson); } catch (e) { return { ok: false, error: 'イベントJSONが不正です' }; }
  if (!ev || !ev.type || !ev.matchKey || !ev.idemKey) return { ok: false, error: '必須項目（type/matchKey/idemKey）が不足しています' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: 'ロック取得タイムアウト。もう一度試してください。' }; }
  try {
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var key = _mqueueKey_(docKey);
    var loaded = _loadMQueue_(data, key);
    var q = loaded.obj;
    // 診断のため重複排除を一時的に無効化（原因切り分け用）。原因特定後に復元する。
    // if (q.seenIdem[ev.idemKey]) return { ok: true, dedup: true };   // 既知のidemKey→再追記しない
    var seq = q.nextSeq++;
    ev.seq = seq;
    ev.receivedAt = new Date().toISOString();
    q.events.push(ev);
    q.seenIdem[ev.idemKey] = true;
    _saveMQueue_(sh, loaded.rowIdx, key, q);
    return { ok: true, seq: seq };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

function _seedingKey_(docKey) { return String(docKey || 'default') + '__seeding'; }

/**
 * Excel等から座組（リング×スロット×機体番号等）をまとめて登録する（書き込み専用トークンで保護）。
 * seedingJson = JSON.stringify({ ringSlots: [{tid, slot, number, playerName, affiliation,
 *               representative, furigana, affiliationFurigana}, ...] })
 * 全体上書き。「既に結果が入っているトーナメントへは適用しない」判断はフロント側（app.html）で行う。
 */
function apiRegisterSeeding(docKey, seedingJson, token) {
  if (!_checkWriter_(token)) return { ok: false, error: '認証エラー' };
  var seeding;
  try { seeding = JSON.parse(seedingJson); } catch (e) { return { ok: false, error: '座組JSONが不正です' }; }
  if (!seeding || !Array.isArray(seeding.ringSlots)) return { ok: false, error: 'ringSlots配列が必要です' };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: 'ロック取得タイムアウト。もう一度試してください。' }; }
  try {
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var key = _seedingKey_(docKey);
    seeding.updatedAt = new Date().toISOString();
    var now = new Date();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === key) { sh.getRange(i + 1, 2, 1, 2).setValues([[JSON.stringify(seeding), now]]); return { ok: true }; }
    }
    sh.appendRow([key, JSON.stringify(seeding), now]);
    return { ok: true };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/**
 * serval管理画面が数秒間隔でポーリングする読み取り専用API。
 * 最新の座組（登録されていれば毎回返す。適用要否はフロント側の判断に委ねる）と、
 * 未消化の試合イベント（apiAckPendingEventsで消化されるまで残る）を返す。
 * 認証不要（apiLoadと同様、読み取りのみ）。
 */
function apiGetPendingEvents(docKey) {
  var sh = getStoreSheet_();
  var data = sh.getDataRange().getValues();
  var seedingKey = _seedingKey_(docKey), mqueueKey = _mqueueKey_(docKey);
  var seeding = null, events = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === seedingKey) {
      try { var s = JSON.parse(data[i][1]); if (s) seeding = s; } catch (e) {}
    }
    if (data[i][0] === mqueueKey) {
      try { var q = JSON.parse(data[i][1]); if (q && Array.isArray(q.events)) events = q.events; } catch (e) {}
    }
  }
  return { ok: true, seeding: seeding, events: events };
}

/**
 * serval管理画面が適用済みイベントのseqを通知。受信箱から該当分を削除して肥大化を防ぐ。
 * 既存のADMIN_TOKEN認証で保護（Excel等の書き込み専用トークンとは別、閲覧側からは呼ばれない）。
 */
function apiAckPendingEvents(docKey, seqListJson, token) {
  if (!_checkAdmin_(token)) return { ok: false, error: '認証エラー' };
  var seqList;
  try { seqList = JSON.parse(seqListJson); } catch (e) { return { ok: false, error: 'seqリストが不正です' }; }
  if (!Array.isArray(seqList) || !seqList.length) return { ok: true };
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: 'ロック取得タイムアウト。もう一度試してください。' }; }
  try {
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var key = _mqueueKey_(docKey);
    var loaded = _loadMQueue_(data, key);
    var q = loaded.obj;
    var seqSet = {};
    seqList.forEach(function(s){ seqSet[s] = true; });
    q.events = q.events.filter(function(ev){ return !seqSet[ev.seq]; });
    if (loaded.rowIdx >= 0) _saveMQueue_(sh, loaded.rowIdx, key, q);
    return { ok: true };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

/**
 * 「結果を取り消す」操作に連動し、該当試合(matchKey)ぶんのidemKey重複排除記録を消す。
 * これが無いと、取り消し後に全く同じ勝者・スコアで再確定しても
 * 「既に見た内容」として黙って弾かれ、Excel連携が二度と反映されなくなる。
 * 既存のADMIN_TOKEN認証で保護（Excel等の書き込み専用トークンとは別、閲覧側からは呼ばれない）。
 */
function apiClearIdemForMatch(docKey, matchKey, token) {
  if (!_checkAdmin_(token)) return { ok: false, error: '認証エラー' };
  if (!matchKey) return { ok: true, cleared: 0 };
  var prefix = 'result|' + matchKey + '|';
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (e) { return { ok: false, error: 'ロック取得タイムアウト。もう一度試してください。' }; }
  try {
    var sh = getStoreSheet_();
    var data = sh.getDataRange().getValues();
    var key = _mqueueKey_(docKey);
    var loaded = _loadMQueue_(data, key);
    var q = loaded.obj;
    var cleared = 0;
    Object.keys(q.seenIdem).forEach(function(k){
      if (k.indexOf(prefix) === 0) { delete q.seenIdem[k]; cleared++; }
    });
    if (cleared > 0 && loaded.rowIdx >= 0) _saveMQueue_(sh, loaded.rowIdx, key, q);
    return { ok: true, cleared: cleared };
  } finally { try { lock.releaseLock(); } catch (e) {} }
}
