# PowerPoint右側ペインとプロジェクト共有

## PowerPoint内で開く

1. PowerPointを閉じて`Setup-DesignerExtension.cmd`を実行します。PowerPointのタスクペイン用に、現在のWindowsユーザー向け`localhost`証明書を作成します。
2. 表示される確認で証明書を信頼すると、Windowsの現在のユーザーの「信頼されたルート証明機関」に登録されます。証明書の秘密鍵とパスフレーズは`runtime/office-taskpane`に保存され、現在のユーザーとSYSTEMだけが読めるように設定します。信頼を拒否するとブラウザー版は使えますが、PowerPoint内ペインは開きません。
3. Setupは`native/Register.ps1`で次の2つを現在のユーザーに登録します（管理者権限・ファイルのアップロードは不要）。
   - `HKCU\Software\Microsoft\Office\16.0\WEF\Developer`に`Designer-Extention-TaskPane.xml`を登録（Officeの開発ツールと同じサイドロード方式）。
   - COMアドイン`DesignerExtension.Connect`。PowerPointの起動時にローカルアプリを自動起動し、「Designer Extention」タブを追加します。
4. 生成された`Designer-Extention-Start.pptx`を開くと右側ペインが開きます。一度開いた後は、ホームタブの**スライド作成**からどの資料でも開けます。表示されない場合は**ホーム → アドイン**の一覧からDesigner Extentionを選びます。

ローカルアプリ版はデスクトップ版PowerPoint専用です。PowerPoint for the webに`Designer-Extention-TaskPane.xml`を追加すると、Edge・Chrome（142以降）のローカル ネットワーク アクセスの制限により「接続がブロックされました」と表示されます。Web版では[インストール不要版](no-install.md)を公開URLで使ってください。

タスクペインは`https://localhost:4318`を使い、`127.0.0.1`と`::1`の両方で待ち受けます（クライアントによって`localhost`の解決先が異なり、片方だけでは接続が拒否されるため）。ブラウザー版は通常`http://127.0.0.1:4317`ですが、このポートが使えない場合は起動スクリプトが空いているローカルポートを選びます。通信はこのPCのループバックに限定します。タスクペイン用の起動認証はHttpOnly・Secure Cookieで受け渡し、認証トークンを画面のJavaScriptやPowerPointマニフェストへ含めません。Task paneはOffice.jsをMicrosoftのCDNから読み込みます。Office.jsの読み込みのためインターネット接続が必要ですが、資料やプロンプトをMicrosoftのCDNへ送る処理はありません。Office.jsが初期化できない場合も3秒後に画面を表示します。

### 開いている資料への挿入

マニフェストの権限は`ReadWriteDocument`です。右側ペインで作成した後に**この資料に挿入**を選ぶと、生成したPPTXを`insertSlidesFromBase64`（PowerPointApi 1.2）で、選択中のスライドの後ろ（選択がなければ末尾）へ「元の書式を保持」で追加します。既存スライドの変更・削除は行いません。PowerPointApi 1.2に対応しない環境ではボタンを表示せず、従来どおり別ファイルで開きます。

証明書を削除する場合は、PowerPointのタスクペインを使わないことを確認してから次を実行します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-Office-TaskPane.ps1 -Remove
```

このコマンドはスクリプトが記録した証明書だけをWindowsの現在のユーザーから削除し、タスクペイン用の鍵ファイルを消します。アドインマニフェストの登録解除はPowerPointのアドイン画面から行います。

## プロジェクトの記憶

画面上部のプロジェクト名からプロジェクトを追加し、対象読者・デザイン方針を設定できます。プロジェクトごとに履歴とお気に入りが絞られます。対象読者と方針は作成依頼の構造化されたコンテキストに加わり、今回の指示と食い違うときは今回の明示指示を優先します。

この情報は`runtime/projects.json`に保存します。履歴・デザイン・設定も引き続きこのPCの`runtime`以下に置きます。会社の情報を使う場合は、AI処理先と送信同意の説明を確認してください。

## デザイン設定を共有

1. 共有したいプロジェクトを選び、**お気に入り**を開きます。
2. **共有用に書き出す**でJSONを保存し、会社やゼミの承認された共有方法で渡します。
3. 受け取った側は自分の対象プロジェクトを選び、**共有設定を取り込む**でJSONを読み込みます。

JSONに入るのはデザイン名、モード、テーマ、書体、構図ID、投票数です。スライド本文、数値、出典、添付資料、プレビュー画像、会話、AIログイン情報は含めません。オンラインアカウントやリアルタイム同期を用いないため、チームの評価を自動同期しません。投票数はファイルに含まれ、読み込み先では参考値として扱います。
