# Serval（トーナメント管理システム）

このディレクトリで作業を始める前に、まず **`G:\マイドライブ\開発\開発環境共有\todo\HANDOFF.md` を必読**。現在の版・実装済み機能・コードの場所・デプロイ手順・GAS固有の落とし穴がまとまっている。

## 最重要の落とし穴（HANDOFFの要約・先に知っておくこと）
- **デプロイ**: Claude Codeから `clasp` / `bump.sh` を直接実行するとハーネスが `H.replace`/`H.trim` で落ちる。
  必ず `Bash` で **`bash deploy.sh` を `run_in_background: true`** 起動し、結果は `/tmp/serval_dbg.log` を Read で確認する。
  デプロイ前に `app.html` の `"serval" verNN` を **手動で +1**（bump.sh は使わない）。
- **デプロイは2系統**: deploy.sh が Serval（メイン）と Serval2（コピー、`serval2/.clasp.json`）の両方へ push+deploy する。
  ログで `EXIT1=0`/`EXIT2=0`/`EXIT=0` と **両方に「Pushed 5 files」** が出ることを確認（「Skipping push.」は反映失敗＝push -f が要る）。
- **clasp認証切れ**（`invalid_rapt`）はユーザーにターミナルで `clasp login` を依頼（`sin1@sin1.studio`）。
- 反映確認は **Ctrl+Shift+R**（GASはHTMLを強くキャッシュ）。
- GAS制約: `<script>`は~22KBで分割 / iframe内はURL不可視→`__EXECURL__`注入 / **`google.script.run`はDateを返すとnull化→`toISOString()`で文字列化**。

詳細・関数の場所・次の一手は `G:\マイドライブ\開発\開発環境共有\todo\HANDOFF.md` を参照。

## ファイル操作のルール
- **ファイル削除は禁止**。不要になったファイルは `DELETE/` フォルダを作成してそこへ移動する。
  （例: `New-Item -ItemType Directory -Force DELETE; Move-Item -Force 対象 DELETE\`）
- `DELETE/` は `.gitignore` 済みなので git には入らない。実際の削除はユーザーが判断して行う。
