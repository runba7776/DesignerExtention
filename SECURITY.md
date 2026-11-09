# セキュリティポリシー

## 対応する版

| 版 | 対応 |
|---|---|
| 0.1.x | ○ |
| 0.1.0より前（開発中の番号） | × |

## 脆弱性の報告

公開のIssueには書かず、GitHubの非公開の報告を使ってください。リポジトリの **Security** タブ → **Report a vulnerability** から送れます。

書いてほしいこと：

- 影響を受ける版と場所（ローカルアプリ版かインストール不要版か、ファイルやURL）
- 再現の手順
- 想定される影響

個人で開発しているため、返信まで時間がかかることがあります。修正した後は、報告者の希望に合わせて内容を公表します。

## 対象の範囲

- ローカルアプリ版：127.0.0.1だけで待ち受けるサーバー、タスクペイン、COMアドイン、描画プログラム
- インストール不要版：GitHub Pagesで公開している静的なページとマニフェスト
- 対象外：外部のAIサービス（Claude、ChatGPT、Ollama）そのもの、利用者のPCやOfficeの設定

データの送り先と保存先は、設計書の [3 データの流れ](docs/system-design.md#3-データの流れ) と [4 非機能要件](docs/system-design.md#4-非機能要件) にあります。

## English

Please report vulnerabilities privately through GitHub (**Security** tab → **Report a vulnerability**), not in a public issue. Supported version: 0.1.x.
