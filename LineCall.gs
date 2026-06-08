/**
 * LineCall.gs — トーナメント管理(serval)から LINE 呼び出し通知システム(line-call-system)を叩く連携モジュール
 *
 * 導入:
 *   1) このファイルを serval の GAS プロジェクトに置く（clasp push で自動アップロード）
 *   2) プロジェクトの設定 > スクリプト プロパティ に以下を登録:
 *        LINE_CALL_BASE_URL  例 https://xxxx.trycloudflare.com  (A方式は当日のURLに毎回更新)
 *        LINE_CALL_TOKEN     line-call-system の SERVICE_TOKEN の値（別途安全に受領）
 *   3) testLineConnection() を実行して疎通確認（通知は飛ばない）
 *
 * 番号ルール: トーナメント側のチームID(=選手枠の「番号」) = LINE側の管理番号（数字のみ）。
 * フロント(index.html)からは google.script.run.apiCallTeams(numbers, type) で呼ぶ。
 * 詳細仕様: line-call-system の INTEGRATION.md 参照。
 */

/** 設定を取得（未設定なら例外）。末尾スラッシュは除去する。 */
function _lineCallConfig_() {
  const p = PropertiesService.getScriptProperties();
  const base = p.getProperty('LINE_CALL_BASE_URL');
  const token = p.getProperty('LINE_CALL_TOKEN');
  if (!base || !token) {
    throw new Error('Script Properties に LINE_CALL_BASE_URL と LINE_CALL_TOKEN を設定してください');
  }
  return { base: base.replace(/\/+$/, ''), token: token };
}

/**
 * 指定チーム番号へ LINE 呼び出しを送る。
 * @param {Array} numbers 管理番号(数字)の配列。数値/文字列どちらでも可
 * @param {string} type 'preparation' | 'deadline' | 'custom'
 * @param {string} [customText] type='custom' のときの本文（省略時は管理画面の既定文）
 * @return {Object} { sent, type, results } APIレスポンス
 */
function callLineTeams(numbers, type, customText) {
  const cfg = _lineCallConfig_();
  const payload = { numbers: (numbers || []).map(String), type: type };
  if (type === 'custom' && customText) payload.customText = customText;

  const res = UrlFetchApp.fetch(cfg.base + '/api/call', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) {
    throw new Error('LINE呼び出し失敗 (' + code + '): ' + text);
  }
  const body = JSON.parse(text);
  Logger.log('LINE呼び出し: sent=' + body.sent + ' / ' + JSON.stringify(body.results));
  return body; // results内の unlinked(未登録)/not_found(番号なし) は呼び出し側でハンドリング可
}

/** 「準備」で呼ぶ（まもなく試合開始） */
function callPreparation(numbers) { return callLineTeams(numbers, 'preparation'); }

/** 「締切」で呼ぶ（受付終了が近い） */
function callDeadline(numbers) { return callLineTeams(numbers, 'deadline'); }

/** 「任意文」で呼ぶ（開会式・全体連絡など） */
function callCustom(numbers, text) { return callLineTeams(numbers, 'custom', text); }

/**
 * フロント(index.html)から google.script.run で呼ばれる窓口。
 * 例外を投げず {ok, sent, type, results} / {ok:false, error} を返す（UI側でトースト表示）。
 * @param {Array} numbers チーム番号(数字)の配列
 * @param {string} [type] 既定 'preparation'
 * @param {string} [customText] type='custom' のときの本文
 */
function apiCallTeams(numbers, type, customText) {
  try {
    const body = callLineTeams(numbers, type || 'preparation', customText);
    return { ok: true, sent: body.sent, type: body.type, results: body.results };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/**
 * 接続テスト。実在しないダミー番号に送り、認証とURLだけ確認する（通知は飛ばない）。
 * 成功すると Logger に sent=0 / not_found が出る。
 * 401 ならトークン誤り、接続不可なら BASE_URL や line-call-system の起動状況を確認。
 */
function testLineConnection() {
  const body = callLineTeams(['__connection_test__'], 'preparation');
  Logger.log('接続OK: ' + JSON.stringify(body));
  return body;
}
