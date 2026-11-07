import { Modal } from './ui';

/** Shown on the no-install site: how to add this page to PowerPoint. Only the
 * manifest (an XML file) goes into PowerPoint; nothing is installed. */
export function AddinGuide({ onClose }: { onClose: () => void }) {
  const manifest = new URL('manifest.xml', document.baseURI).href;
  return (
    <Modal title="PowerPointのアドインとして使う" onClose={onClose}>
      <p className="modal-prose">
        右側のペインから同じ機能を使い、作成したスライドを開いている資料へ直接挿入できます。ソフトのインストールやファイルの実行はありません。PowerPointに読み込むのは、このページの場所を書いた設定ファイル（manifest.xml）だけです。
      </p>
      <ol className="guide-steps">
        <li>
          <strong>設定ファイルを保存</strong>
          <span>
            <a href={manifest} download="Designer-Extension-manifest.xml">
              manifest.xml をダウンロード
            </a>
          </span>
        </li>
        <li>
          <strong>Web版のPowerPointで資料を開く</strong>
          <span>
            <a href="https://www.office.com/launch/powerpoint" target="_blank" rel="noreferrer">
              PowerPoint for the web
            </a>
            にMicrosoftアカウントでサインインします。個人用のアカウントで使えます。
          </span>
        </li>
        <li>
          <strong>読み込む</strong>
          <span>
            ホーム → アドイン → その他の設定 → マイ
            アドインのアップロード（「個人用アドインのアップロード」の場合もあります）→ 参照 → 保存したファイル →
            アップロード
          </span>
        </li>
        <li>
          <strong>右側のペインを開く</strong>
          <span>
            ホームタブの「スライド作成」を押します。開いている資料のスライドを選ぶと「図解にする」「文章を短くする」なども使えます。
          </span>
        </li>
      </ol>
      <p className="modal-prose">
        読み込んだ内容はそのブラウザーに残ります。別のブラウザーで使うときやキャッシュを消した後は、もう一度読み込みます。組織のアカウントでアップロードが制限されている場合は、個人のアカウントで試せます。
      </p>
      <details className="connector-help">
        <summary>デスクトップ版のPowerPointで使う</summary>
        <p>
          <strong>Windows</strong>
          ：アップロードの項目がないため、共有フォルダーから読み込みます。フォルダーの共有に管理者権限が必要な場合があります。
        </p>
        <ol className="guide-steps">
          <li>
            保存したファイルを入れたフォルダーを共有します（プロパティ → 共有 → 共有）。表示された \\PC名\フォルダー名
            を控えます。
          </li>
          <li>
            ファイル → オプション → トラスト センター → トラスト センターの設定 → 信頼できるアドイン カタログで、控えた
            \\PC名\フォルダー名 を追加し、「メニューに表示する」にチェックします。このページのURLでは読み込めません。
          </li>
          <li>PowerPointを起動し直し、ホーム → アドイン → 詳細設定 → 共有フォルダー → Designer Extension → 追加。</li>
        </ol>
        <p>やめるときは、同じ画面でカタログを削除し、フォルダーの共有を解除します。</p>
        <p>
          <strong>Mac</strong>
          ：Finderの「フォルダへ移動」で ~/Library/Containers/com.microsoft.Powerpoint/Data/Documents/wef
          を開き（なければ作成）、保存したファイルを入れます。PowerPointを起動し直し、ホーム → アドインから選びます。
        </p>
      </details>
      <p className="modal-prose">
        データの扱い：資料の読み取り・スライドの作成はこのブラウザの中で行い、履歴・お気に入り・設定はこのブラウザに保存します。AIへの受け渡しは、指示をコピーしてご自身のAIチャットに貼り付ける方式か、ご自身のPCのローカルLLMだけです。
      </p>
      <div className="settings-actions">
        <button className="button primary" onClick={onClose}>
          閉じる
        </button>
      </div>
    </Modal>
  );
}
