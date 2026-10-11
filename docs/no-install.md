# インストール不要版

PowerPointに`manifest.xml`をアップロードするだけで使える版です。使う人のPCでファイルを実行したり、証明書やソフトを入れたりする必要はありません。評価・お試しにはこの版を案内してください。

## 使う人の手順（評価者向け）

1. 公開ページ <https://runba7776.github.io/DesignerExtention/> を開きます。ブラウザーのままでも、資料の読み込み→構成→スライド作成→PPTXの保存まで試せます。
2. PowerPointで使う場合は、ページ下部の**PowerPointのアドインとして使う**から`manifest.xml`を保存します。
3. PowerPoint（Web版またはデスクトップ版）で、**ホーム → アドイン → その他のアドイン → マイ アドイン → マイ アドインのアップロード**を選び、保存した`manifest.xml`を指定します。
4. ホームタブの**スライド作成**で右側のペインが開きます。

組織のMicrosoft 365でアドインのアップロードが制限されている場合は、個人のMicrosoftアカウントでPowerPoint for the webを開くと試せます。削除はPowerPointの「マイ アドイン」から行えます。

PowerPoint for the webで使うのは、公開URL（`https://<user>.github.io/...`）から保存した`manifest.xml`だけです。`https://localhost`を指すマニフェスト（ローカルアプリ版の`Designer-Extention-TaskPane.xml`や、公開前の確認用に作る`dist/hosted/manifest.xml`）は、Edge・Chrome（142以降）の「ローカル ネットワーク アクセスの制限」によりWeb版の中で読み込めず、「公開ページでローカル ネットワーク上のデバイスまたはサーバーへの接続が開始されたため、接続がブロックされました」と表示されます。Office側が作る枠の中で起きるため、アドイン側やブラウザーの設定では回避できません。

### 試しやすい流れ

| 試すこと | 操作 |
|---|---|
| AIなしで全体の流れ | 設定 → 処理する場所「サンプル体験」→ サンプルを見る → この構成で作成 → PowerPoint ファイルを作成 → この資料に挿入 |
| AIチャットで作成（APIキー不要） | 設定 →「手動チャット連携」→（推奨）「AIの準備を始める」でChatGPT・Claudeにプロジェクトを1回作る → 資料と指示を入れて「構成を考える」→「指示をコピーして○○を開く」→ 返答をコピーして戻り「コピーした返答を取り込む」 |
| 選択中のスライドを作り直す | PowerPointでスライドを選ぶ →「開いている資料で使う」→ 図解にする／グラフにする／文章を短くする |
| 会社テンプレート | プロジェクト → 会社テンプレート →「開いている資料から読み込む」→「このテンプレートで作成する」 |
| 出典の確認 | 資料を添付して作成 → 各スライドの「出典 n」→ 原文と数値の照合結果 |
| 発表準備 | 作成した資料の「発表準備」→ 持ち時間を入れて時間配分／原稿と想定質問 |

## データの扱い

- 公開ページはHTML・JavaScriptを配信するだけです。資料・指示・スライドを受け取るサーバーはありません。
- 資料（PDF・Excel・PowerPoint・CSV・テキスト）の読み取りとPPTXの作成は、ブラウザー（PowerPointの右側ペイン）の中で行います。
- 履歴・お気に入り・プロジェクト・設定は、そのブラウザーのIndexedDBに保存します。ブラウザーのサイトデータを消すと削除されます。別のPC・ブラウザーとは共有されません（チームとの共有は「共有用に書き出す」ファイルで行います）。
- AIへの受け渡しは、指示をコピーしてご自身のAIチャットに貼り付ける方式か、ご自身が指定したローカルLLM（このPCまたは社内のプライベートIP）だけです。自動でクラウドへ送る処理はありません。

## ローカルアプリ版との違い

| | インストール不要版 | ローカルアプリ版 |
|---|---|---|
| 月額版での自動作成（ChatGPT・Claudeへのログイン連携） | なし | あり |
| スライドの描画 | ブラウザー内（PptxGenJS）。グラフは編集可能なPowerPointのグラフ、SmartArtは編集可能な図形 | PowerPoint本体（SmartArt・プレビュー画像あり） |
| 履歴の保存先 | ブラウザー | このPCの`runtime/` |

## 公開する手順（作者向け）

GitHub Pagesで公開する場合の手順です。`.github/workflows/pages.yml`がビルドと公開を行います。

1. GitHubにリポジトリを作り、このフォルダーをpushします（`runtime/`・`node_modules/`・`dist/`・`.qa-claude-config/`は`.gitignore`で除外済みです）。
2. リポジトリの **Settings → Pages → Build and deployment → Source** で **GitHub Actions** を選びます。
3. `main`ブランチへのpush（またはActionsの「Run workflow」）で、`https://<user>.github.io/<repo>/`に公開されます。`manifest.xml`は公開URLに合わせて自動生成されます。

別のホスティングに置く場合は、公開URLを指定してビルドし、`dist/hosted`をそのまま配置します。HTTPSが必要です。

```powershell
$env:HOSTED_BASE_URL = 'https://example.com/designer/'
npm run build:hosted
```

### 公開前の確認

```powershell
npm run build:hosted
npm run serve:hosted
```

`https://localhost:4320/`で公開時と同じ構成を確認できます（ローカルアプリ版の証明書を使います）。このときの`dist/hosted/manifest.xml`は`localhost`を指すため、**デスクトップ版PowerPoint専用**です（Web版では上記の制限で読み込めません）。

## 制約

- 選択中のスライドへの操作と開いている資料の読み取りは、PowerPointApi 1.5以上（Microsoft 365の最新版デスクトップ／Web版）で使えます。資料への挿入はPowerPointApi 1.2以上です。
- ローカルLLMへ接続するには、LLMサーバー側で公開ページからの接続（CORS）を許可してください。Ollamaは`OLLAMA_ORIGINS`に公開ページのURLを追加して再起動、LM Studioは「CORSを有効化」をオンにします。公開ページをブラウザーで直接開いた場合は、アドレスバーに表示される「ローカル ネットワーク上のデバイスへの接続」を許可してください。**PowerPoint for the webの中からはローカルLLMに接続できません**（同じ制限のため）。Web版では手動チャット連携を使ってください。
- 画像だけのPDFの文字認識、PDF内の図表の解析は行いません。
