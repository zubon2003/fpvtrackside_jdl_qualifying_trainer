# JDL Qualifying Trainer

FPVTrackside用の「90秒ステガードスタート・クオリファイ」formatを走らせるための一式です。

- **`JDL_Qualifying_Trainer/`** — FPVTrackside Extensionの受信サーバー(Node.js)。音声アナウンス、ライブ90s順位表示、リーダーボード、Google Sheets書き出しを担当します。
- **`time_trial_laps_then_time.lua`** — FPVTrackside側に読み込ませるステージスクリプト。各パイロットのホールショットから90秒以内に開始した周回をカウントし、周回数→タイムの順でランキングします。

## セットアップ

1. `JDL_Qualifying_Trainer/` フォルダで依存関係をインストール
   - Windows: `sample_install.bat`
   - Mac/Linux: `./sample_install.sh`
2. サーバーを起動
   - Windows: `sample_start.bat`(ログファイルも残したい場合は `sample_start.bat --log`)
   - Mac/Linux: `pnpm start`(ログファイルも残したい場合は `pnpm start -- --log`)
3. ブラウザで `http://127.0.0.1:8765/` を開き、コントロールパネルから音声・TTS・Live 90s表示などを設定
4. FPVTracksideのExtension設定で、このサーバーのNotification URL(`http://127.0.0.1:8765/`)を指定し、`time_trial_laps_then_time.lua` をステージスクリプトとして読み込む

## Google Sheets書き出しを使う場合

Time Trial結果をGoogleスプレッドシートへ自動書き出しする機能を使うには、サービスアカウントの鍵ファイル `credentials.json` が必要です(リポジトリには含まれていません)。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを用意する
2. 「APIとサービス」→「ライブラリ」から **Google Sheets API** を有効化する
3. 「APIとサービス」→「認証情報」→「認証情報を作成」→「サービスアカウント」を作成する(ロール付与は不要)
4. 作成したサービスアカウントの「キー」タブから「新しい鍵を作成」→ JSON形式でダウンロードする
5. ダウンロードしたファイルを `credentials.json` にリネームし、`JDL_Qualifying_Trainer/`(`server.js` と同じ階層)に置く
6. JSON内の `client_email` をコピーし、書き出し先のGoogleスプレッドシートの「共有」設定で**編集者**として追加する
   (サービスアカウントは自分のドライブを持たないため、これをしないと書き出し時に `403` エラーになります)
7. コントロールパネルの「Google Sheets 書き出し」で自動書き出しをON、Spreadsheet ID(スプレッドシートURLの `/d/` と `/edit` の間の文字列)とシート名を設定する

## License

MIT
