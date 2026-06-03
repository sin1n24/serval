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
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    // スタンドアロンスクリプトとして実行された場合は新規スプレッドシートを作成して紐付ける
    ss = SpreadsheetApp.create('TournamentManager-Store');
    PropertiesService.getScriptProperties().setProperty('SS_ID', ss.getId());
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
  // ここではそのまま保存し、OKを返すことでフロントの「進むアニメーション」を発火させる。
  apiSave(key, payloadJson);
  return { ok: true, key: key, receivedAt: new Date().toISOString() };
}
