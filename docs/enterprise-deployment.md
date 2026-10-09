# 企業向け配布方針

## 現在のローカル版

この開発版は、各PC上でアプリを起動し、`https://localhost:4318`からPowerPointのタスクペインを表示します。初回は各ユーザーがローカル証明書を信頼し、マニフェストをアップロードします。個人利用や開発・検証には使えますが、自己署名証明書の信頼や未署名PowerShellの実行を全社員に求める形での一括配布は推奨しません。

個人用セットアップは`Setup-DesignerExtension.cmd`をダブルクリックします。このラッパーはPowerShellを現在のユーザー権限で起動し、実行ポリシーをそのプロセスに限って指定します。Windowsの永続的な実行ポリシーは変更しません。組織のグループポリシーがスクリプト実行を制限している場合は、その制限を回避せず管理者に確認してください。

## 企業配布に必要な構成

企業展開では、次の管理された配布経路へ移行します。

1. Web画面を組織が管理するHTTPSホストへ配置し、マニフェストのURLをそのホストに変更する。
2. Microsoft 365管理センターの統合アプリから、管理者が対象ユーザーやグループにアドインを配布する。
3. ローカル処理が必要な会社では、補助サービスを組織のコード署名証明書で署名したインストーラーとしてIntune等から配布する。自己署名ルート証明書のユーザー登録は要求しない。
4. ローカル保存先、モデル接続先、外部AIへ送信できる資料の範囲、ログ保持期間を会社の管理者が設定・承認する。

中央配布するOfficeアドインは、ローカル開発用の`localhost` URLを使いません。Microsoftの案内でも、公開時はWebアプリをHTTPSホストへ配置し、マニフェストのURLを更新してから配布する流れです。Microsoft 365管理センターの統合アプリは管理者がユーザーやグループにOfficeアドインを割り当てる仕組みです。

このリポジトリには、署名済みの企業インストーラー、企業ホスト、組織証明書、Microsoft 365テナントへの配布設定は含まれていません。これらは会社のIT部門が管理する証明書・端末管理・Microsoft 365環境を使って別途構築する必要があります。

参考:

- [Microsoft: Office Add-ins の公開](https://learn.microsoft.com/en-us/office/dev/add-ins/publish/publish)
- [Microsoft 365管理センター: Officeアドインの集中展開](https://learn.microsoft.com/en-us/microsoft-365/admin/manage/centralized-deployment-of-add-ins)
- [Microsoft: PowerShell実行ポリシー](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)
