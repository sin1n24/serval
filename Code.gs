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
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('トーナメント管理システム')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // 配信/呼び出しシステムからiframe埋め込み可
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
