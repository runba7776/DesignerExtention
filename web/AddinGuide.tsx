import { Modal } from './ui';

/** Shown on the no-install site: how to add this page to PowerPoint. Only the
 * manifest (an XML file) is uploaded to PowerPoint; nothing is installed. */
export function AddinGuide({ onClose }: { onClose: () => void }) {
  const manifest = new URL('manifest.xml', document.baseURI).href;
  return (
    <Modal title="PowerPointのアドインとして使う" onClose={onClose}>
      <p className="modal-prose">
        このページはインストール不要で動きます。PowerPointに追加すると、右側のペインから同じ機能を使い、作成したスライドを開いている資料へ直接挿入できます。PCへのソフトのインストールやファイルの実行はありません。PowerPointに登録するのは、このページの場所を書いた設定ファイル（manifest.xml）だけです。
      </p>
      <ol className="guide-steps">
        <li>
          <strong>設定ファイルを保存</strong>
          <span>
            <a href={manifest} download="Designer-Extention-manifest.xml">
              manifest.xml をダウンロード
            </a>
          </span>
        </li>
        <li>
          <strong>PowerPoint（Web版・デスクトップ版）で追加</strong>
          <span>
            ホーム → アドイン → その他のアドイン（または「アドインを入手」）→ マイ アドイン → マイ
            アドインのアップロード → 保存した manifest.xml を選択
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
        組織のMicrosoft 365でアドインのアップロードが制限されている場合は、個人のMicrosoftアカウントのPowerPoint for the
        webで試せます。削除はPowerPointの「マイ アドイン」から行えます。
      </p>
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
