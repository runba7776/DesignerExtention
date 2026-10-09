# Claude月額プランと公式実行環境の連携

確認日: 2026年10月7日。サービスの利用条件・料金体系は更新されるため、配布前にもリンク先を確認してください。

## このアドインの方式

アドイン独自のClaude OAuth認証を作るのではなく、PCにインストールした**未改変の公式Claude Code**を呼び出します。ログイン画面と認証情報の保存・更新は公式実行環境が担当します。アドインはパスワード、ブラウザーCookie、OAuthコード、セッショントークン、公式の認証ファイルを取得しません。

Anthropicは、公式バイナリーを未改変のまま製品から実行する形を、Commercial Termsへの同意、元の認証手段を制限しないこと、各利用者が自身のアカウントと契約で利用することを条件に説明しています。自作アプリ内でのClaude.aiログインや利用者の認証情報の仲介とは区別されています。本実装は各PC・各利用者の公式実行環境を使い、利用枠の共有や販売は行いません。[公式の製品内実行・認証条件](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)

Agent SDKの案内には、事前承認のない第三者製品でClaude.aiログイン・利用枠を提供しないよう記載があります。本実装は独自OAuthクライアント、ログイントークンを転用するSDK、Webチャットの自動操作を採用していません。[Agent SDKの案内](https://code.claude.com/docs/en/agent-sdk/overview#get-started)

## 接続と生成

1. 設定からClaudeの接続を開始します。公式実行環境のブラウザー認証で、ご自身の月額アカウントにログインします。
2. 指示・資料をClaudeへ送ることを確認し、構成を考えます。構成案を確認して作成を開始します。
3. 返答は直接アドインに戻ります。アドインが形式・出典・図表の数値・文字量を検証し、編集できるPowerPointの図形やグラフに変換します。
4. 上限・認証・通信のエラー時に、有料APIへの切り替えは行いません。

アドインは公式CLIの公開コマンドだけを使います。ログイン時は `claude auth login`、接続確認は `claude auth status`、切断は `claude auth logout` です。`--console` はAPI利用の課金方式になるため、アドインの生成には採用しません。元の公式実行環境で利用できる認証方法自体は変更していません。[公式CLIの認証コマンド](https://code.claude.com/docs/en/cli-reference#cli-commands)

CLI専用の設定フォルダーは、アドインの作業フォルダー内の `subscription-claude/config` です。`CLAUDE_CONFIG_DIR` で分離し、利用者が普段使うClaude Codeの設定・ログインへ影響しないようにしています。この中の認証情報も公式CLIだけが管理します。画面でのアカウント表示は、公式CLIが返す接続状態のメールアドレスなどを使います。[公式の設定フォルダーと認証管理](https://code.claude.com/docs/en/iam#log-in-with-multiple-accounts)

接続状態が、月額認証 `authMethod: "claude.ai"`・公式接続先 `apiProvider: "firstParty"`・対応プランであることを生成の前後に確認します。APIキー、Console、外部クラウド、未確認の認証状態では生成を停止します。アカウントや接続を変更した場合は、古い作業の続きを新しい送信先へ自動送信しません。

## ローカルプロセスの仕様

現在のWindowsパッケージは公式npmパッケージ `@anthropic-ai/claude-code` と対応するWindowsバイナリーを使います。v2.1.291の実際の `--version`・`--help`・`auth --help` を、認証情報のない検証用設定フォルダーで確認しています。個人アカウントのログインや実モデルでの生成は検証時に実行していません。

生成時の呼び出しは次の形です。実装はシェルを使わず、各引数を個別に渡します。長い指示・資料はコマンド引数へ埋め込まず標準入力から渡し、標準出力のJSONを読み取ります。

```text
claude -p --output-format json --safe-mode --setting-sources ""
  --tools "" --disallowedTools "mcp__*"
  --strict-mcp-config --mcp-config '{"mcpServers":{}}'
  --no-session-persistence --permission-prompts none --model sonnet
```

既定モデルはSonnetで、Sonnet・Opus・Haikuを選べます。モデルの実際の利用可否は契約・管理者設定に従います。組み込みツール、外部MCPツール、ユーザーのカスタマイズを読み込まない設定にし、CLIの会話保存を無効にします。組織の管理ポリシーは公式CLIが適用します。安全なオプションに対応しない古い実行環境は、更新を求めて停止します。[公開CLIオプション](https://code.claude.com/docs/en/cli-reference#cli-flags)

`--bare` は月額ログインを読み込まずAPIキーなどを要求するため使いません。公式CLIのJSON応答には実行情報と `result`、構造化出力時には `structured_output` が含まれます。アドインは内容だけを検証へ渡し、CLIの金額推定を実際の追加請求として表示しません。[公式のプログラム実行・出力形式](https://code.claude.com/docs/en/headless)

## 利用枠と追加料金

2026年6月16日更新の公式案内では、Agent SDK・`claude -p` の別枠課金への変更は延期され、現時点の利用は購読の利用上限から消費すると説明されています。同じページの過去の月次クレジット案は適用されていないため、そちらを料金保証の根拠にしていません。[延期を知らせる公式更新](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

**APIキー不要と、追加料金が絶対に発生しないことは別です。** Pro・Maxで追加課金を避ける場合は、Claudeの「設定 → 使用量」で使用量クレジットを無効にしてください。有効な場合、月額枠を超える利用が従量課金になることがあります。アドインは支払い設定の取得・変更や、追加課金の許可を行いません。[使用量クレジットの公式説明](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)

Team・Enterpriseでは会社の契約と管理者設定が適用されます。特に利用量に応じて請求されるEnterprise契約では、月額OAuthでログインしていても利用自体が課金対象です。会社の契約条件を確認してください。[Enterpriseの課金方式](https://support.claude.com/en/articles/11526368-how-am-i-billed-for-my-enterprise-plan)

## Claude DesktopとのMCP連携も使える

公式CLIの直接連携を使わない場合は、従来のClaude Desktop用ローカルMCP接続を利用できます。Claude Desktopで現在の作業を取得するよう依頼すると、`designer_get_task` で指示を取得し、`designer_submit_reply` で検証済みの返答をアドインへ戻せます。返答は待機中のアドイン画面へ反映されます。こちらは最初の依頼をClaude Desktop側で行う方式です。

将来、接続設定を手作業で追加する代わりに、`.mcpb` 形式のデスクトップ拡張機能として配布できます。Claude Desktopはローカル拡張機能のインストールに対応し、企業では管理者が許可する拡張を管理できます。[公式のローカルMCP・拡張機能導入](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)

Web用のリモートMCPはAnthropicのクラウドから公開サーバーへ接続する仕組みです。現在のPC内だけのアドインサーバーを、そのままWebコネクターのURLとして使うことはできません。[リモートMCPの接続要件](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp#network-requirements)

## データの扱い

Claudeで生成すると、プロンプト・抽出した資料・会話をAnthropicへ送ります。「ローカルプロセスで公式CLIを呼ぶ」ことは「ローカルLLMでオフライン処理する」こととは異なります。機密資料を外へ送れない場合はローカルLLMモードを使ってください。履歴とお気に入りの保管・PPTXへの描画は引き続きPC内で行います。
