# Serval（トーナメント管理システム）引き継ぎ資料

最終更新: 2026-06-14 / 現在の版: **index.html ver39 / GASデプロイ v57**

## 1. これは何か
M5Stack等とは別の、**GASホスト型の単一HTML Webアプリ**。トーナメント表の作成・運用・観客向け閲覧・大型表示（別画面）・スポンサーバナー・LINE呼出・演出（勝ち上がり/対戦カード）・**演出の動画書き出し**まで持つ。

- 本体: `C:\Users\sin1n\TournamentManager\index.html`（巨大・単一HTML、JSは複数`<script>`に分割）
- サーバ: `Code.gs`（doGet配信 + apiSave/apiLoad/apiList/apiSubmitResult/広告集計）、`LineCall.gs`（LINE呼出）
- 設定: `appsscript.json`（`executeAs: USER_DEPLOYING` / `access: ANYONE_ANONYMOUS` / Asia/Tokyo / V8）
- 公開URL(/exec): `https://script.google.com/macros/s/AKfycbxXvPz1A_5MO08BFpvye_sYMUi5ho8QL1jokvem48ii5Q0rQZ4Ja_1_nIXxzzSLbWhdVA/exec`
- 短縮中継: `go/index.html`（`?doc=`等を/execへ転送）

## 2. デプロイ手順（重要・ハマりどころ）
**Claude Codeから直接 `clasp` / `bump.sh` を実行するとハーネスが `H.replace`/`H.trim` で落ちる。** 次の方法でのみ安定動作した:

1. **版番号を手動で +1**: `index.html` の `<h1>…"serval" verNN</h1>` をEditで +1（`bump.sh`は使わない＝ハーネスが落ちる）。
2. **デプロイはスクリプトをバックグラウンド起動**:
   - `deploy.sh`（検証済み・clasp v3）を `Bash` で `run_in_background: true` 実行。
   - 結果は `/tmp/serval_dbg.log` を Read（`Pushed…` → `Deployed … @NN` → `EXIT=0`）。
   - 中身: `clasp push` → `clasp deploy --deploymentId <上記ID>`。
3. **clasp認証切れ（`invalid_grant`/`invalid_rapt`）**: Workspaceのセッション制御で定期的に失効。ユーザーにターミナルで `! export PATH="$PATH:/c/Users/sin1n/AppData/Roaming/npm:/c/Program Files/nodejs"; clasp login` を依頼（`sin1@sin1.studio`）。
4. 反映確認は **Ctrl+Shift+R**（GASはHTMLを強くキャッシュ）。

## 3. GAS固有の制約（再発防止・必読）
- iframe内(googleusercontent.com)で動くため**JSからURL/locationを読めない** → doGetが `window.__EXECURL__`/`__DOCKEY__`/`__BOARD__`/`__ADMIN__` を注入。`window.open`等は必ず `__EXECURL__` 基準の絶対URL。
- **1つの`<script>`は~22KB目安**で分割（巨大インラインはGASに剥がされ白画面）。新コードは新しい`<script>`ブロックに。
- **`google.script.run` の戻り値にDate等を含めるとクライアントに `null` が来る** → 日時は `toISOString()` で文字列化（`apiList`で実害があり修正済み）。
- 1セル上限~5万字 → `apiSave`は49,500字超でエラー。バナー画像はcanvas圧縮で抑制済み。

## 4. このセッションで実装した主な機能
- **iframe余白除去**: 閲覧モードで`main.stage`を`height:auto`/`overflow:visible`、ブラケット下の空白を解消。
- **🎬 演出設定モーダル**（左パネル「演出設定」）:
  - 自動演出ON/OFF（勝ち上がり/対戦カード/勝者線点滅）、演出時間（ADV/SP秒）。
  - **管理側のみ演出**（閲覧へ配信しない）/**管理側のみ効果音**のチェック。
  - **効果音**: 勝ち上がり用・対戦カード用を**別々に**選択。各プリセット3種＋URL指定＋**試聴▶**。Web Audio APIで生成。
- **スマホ初回50%ズーム**: タッチ端末/幅<768px/キャッシュ無し時に`config.zoom=0.5`。
- **演出のXY位置補正**: `_matchXY()`で勝者線の交点に演出（⚡）を合わせる。
- **🎞 動画用に書き出し**（左パネル「動画用に書き出し」）:
  - 各演出を「時刻tの関数」で1フレームずつ専用canvas(1920×864)へ決定的描画→**PNG連番=厳密CFR 30fps**。
  - クリップ: **スレート / 勝ち上がり / トーナメント進行(赤点滅) / 暗転**、演出ごとに別フォルダ＝別連番。
  - **進行ブラケット**は、各試合時点の「結果>Nをクリアした過去状態」を一時再現→`renderBracket()`→**DOM/SVGの実座標をcanvasへ転写**（再実装しない）。変化線は`data-wk`で特定し赤点滅。転写中は view-mode に切替（閲覧見た目）。
  - 出力は**無圧縮ZIP**（自前store-zip+CRC32）。同梱の `build_mp4.sh/.bat` でFFmpeg→`1920×864/H.264/yuv420p/CFR`、`durations.txt`に正確な尺。
- **📂 開く / ✚ 新規**（topbar）: `apiList`で保存済み一覧（名前・選手数・トーナメント数・枠サイズ・更新日時）。行クリックで読込。新規は保存名入力で空トーナメント生成。
- **リネーム**: `JSON↓→⬇バックアップ` / `JSON↑→⬆復元`。「読込」は「📂開く」に統合。
- **修正**: `apiList`のDate→ISO文字列化（一覧0件/null化バグ）。`doLoad`の警告を`isDirty()`基準（編集して未保存のときだけ確認）。

## 5. 主要コードの場所（index.html内、関数名で検索）
- 状態: `let state = {`（`config`に演出/効果音/zoom等のフラグ）
- 演出: `showAdvanceCtx` `showSpotlightCtx` `showAdvance` `showSpotlight` `_matchXY` `maybeShowBroadcast`
- 効果音: `playAdvSfx` `playSpSfx` `sfxAdv1..3` `sfxSp1..3` `syncEffectsModal`
- 動画書き出し: `buildExportClips` `exDrawFrame` `runExportVideo` `_zipStore` `_crc32`（1ブロック）
  - 進行転写: `transcribeBracket` `prepProgressClips` `drawBracketBase` `drawBracketBlink` `exDrawProgressFrame`（別ブロック）
- 開く/新規: `openOpenModal` `refreshOpenList` `summarizeDoc` `newDocument`
- 保存/読込: `doSave` `doLoad` `doExport` `doImport` `markSaved` `isDirty` / Backend抽象は `const Backend = (function(){`
- 試合データ: `matchBrief` `matchCompetitors` `matchKeyResult` `matchNoMap` `competitorOf` `drawConnector`（winKey=`data-wk`）

## 6. 既知の注意 / 次の一手候補
- デプロイは必ず §2 の手順（background + ログ読み）。直叩きは禁止（ハーネス落ち）。
- 動画書き出しは未編集の実機で見え方（進行の空欄/記入差・赤点滅・⚡位置）を要目視確認。調整余地: 点滅速度・尺・ブラケット拡大率・カードのフォント/行数・暗転をクロスフェード化。
- Workspaceセッション制御を「無期限」にすれば clasp 再ログイン頻度を減らせる（Admin Console → セキュリティ → Google Cloud セッション制御）。

## 7. 関連メモリ（.claude/.../memory/）
- `serval-gas-deployment` / `serval-version-bump` / `serval-gas-white-screen` / `serval-gas-run-date-null` / `clasp-powershell-wedge`
