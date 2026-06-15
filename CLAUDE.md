# Serval（トーナメント管理システム）

このディレクトリで作業を始める前に、まず **[HANDOFF.md](HANDOFF.md) を必読**。現在の版・実装済み機能・コードの場所・デプロイ手順・GAS固有の落とし穴がまとまっている。

## 最重要の落とし穴（HANDOFFの要約・先に知っておくこと）
- **デプロイ**: Claude Codeから `clasp` / `bump.sh` を直接実行するとハーネスが `H.replace`/`H.trim` で落ちる。
  必ず `Bash` で **`bash deploy.sh` を `run_in_background: true`** 起動し、結果は `/tmp/serval_dbg.log` を Read で確認する。
  デプロイ前に `index.html` の `"serval" verNN` を **手動で +1**（bump.sh は使わない）。
- **clasp認証切れ**（`invalid_rapt`）はユーザーにターミナルで `clasp login` を依頼（`sin1@sin1.studio`）。
- 反映確認は **Ctrl+Shift+R**（GASはHTMLを強くキャッシュ）。
- GAS制約: `<script>`は~22KBで分割 / iframe内はURL不可視→`__EXECURL__`注入 / **`google.script.run`はDateを返すとnull化→`toISOString()`で文字列化**。

詳細・関数の場所・次の一手は HANDOFF.md を参照。
