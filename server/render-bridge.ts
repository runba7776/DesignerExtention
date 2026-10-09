import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DeckSpec, RenderResult } from '../shared/contracts';
import { compileDeck } from '../shared/layouts';
import { AppError } from './errors';
import { assertTextFits } from './text-fit';

const execute = promisify(execFile);
export function createRenderBridge(projectRoot: string) {
  const artifactRoot = path.join(projectRoot, 'runtime', 'artifacts');
  const executable = path.join(projectRoot, 'native', 'bin', 'DesignerExtension.Renderer.exe');
  let queue = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  async function nativeAvailable() {
    if (process.platform !== 'win32') return false;
    try { await fs.access(executable); return true; } catch { return false; }
  }
  async function render(deck: DeckSpec, _variantId: string): Promise<RenderResult> {
    assertTextFits(deck);
    if (!(await nativeAvailable())) throw new Error('PowerPoint連携をビルドしてください。「セットアップ」を実行すると準備できます。');
    const scene = compileDeck(deck);
    const artifactId = randomUUID();
    const directory = path.join(artifactRoot, artifactId);
    await fs.mkdir(directory, { recursive: true });
    const inputFile = path.join(directory, 'scene.json');
    await fs.writeFile(inputFile, JSON.stringify(scene), 'utf8');
    return serialized(async () => {
      try {
        const deadline = Date.now() + Math.max(180_000,deck.slides.length*20_000);
        for (let attempt = 0; ; attempt++) {
          try {
            await execute(executable, ['--input', inputFile, '--output', directory], { timeout: Math.max(1000, deadline-Date.now()), windowsHide: true, maxBuffer: 1_000_000 });
            break;
          } catch (error) {
            const stderr = (error as {stderr?: string}).stderr ?? '';
            // Office occasionally returns a stale embedded Excel connection on the
            // next deck. Recreate our own unsaved deck once; never call the LLM again.
            const transient = /RPC_E_CALL_REJECTED|0x80010001/i.test(stderr) || (/グラフ(?:データの(?:初期化|書き込み)|のセル入力)/.test(stderr) && /E_FAIL|RPC_E_DISCONNECTED|0x80010108|0x800706BA|0x800401FD/i.test(stderr));
            const alreadySaved = await fs.access(path.join(directory, 'presentation.pptx')).then(()=>true,()=>false);
            if (attempt > 0 || !transient || alreadySaved || Date.now()+5000 >= deadline) throw error;
            await new Promise(resolve=>setTimeout(resolve, 1500));
          }
        }
      } catch (error) {
        const e=error as Error & { stderr?:string };
        if(e.stderr?.includes('CHART_DATA_MISMATCH'))throw new AppError(502,'PowerPointのグラフ表示値が入力と一致しないため、出力を止めました。数値を書き換えずに、もう一度作成してください。','CHART_DATA_MISMATCH');
        if(e.stderr?.includes('TEXT_FIT_REQUIRED'))throw new AppError(422,`PowerPointで実測した文字が枠を超えました。「構図を変更」で広い配置を選ぶか、該当ページに短くする指示を入力してください。${e.stderr.split('\n')[0].slice(0,400)}`,'TEXT_FIT_REQUIRED');
        throw new AppError(502, `PowerPointでの作成に失敗しました。ダイアログが開いていないか確認してください。${(e.stderr || e.message).split('\n')[0].slice(0,500)}`, 'NATIVE_RENDER_ERROR');
      }
      const result=JSON.parse(await fs.readFile(path.join(directory, 'render-result.json'), 'utf8')) as {pptx:string;thumbnails:string[];warnings?:string[];native?:boolean};
      if(!result.pptx || !Array.isArray(result.thumbnails) || result.thumbnails.length !== scene.slides.length) throw new Error('PowerPointの出力が揃いませんでした。');
      for(const name of [result.pptx,...result.thumbnails]) {
        if(path.basename(name)!==name)throw new Error('出力ファイル名が不正です。');
        await fs.access(path.join(directory,name));
      }
      const url=(file:string)=>`/api/artifacts/${artifactId}/${encodeURIComponent(file)}`;
      return {artifactId,pptxUrl:url(result.pptx),thumbnails:result.thumbnails.map(url),warnings:[...new Set([...scene.slides.flatMap(s=>s.warnings),...result.warnings??[]])],native:result.native===true};
    });
  }
  async function open(artifactId:string) {
    if(!/^[a-f0-9-]{36}$/.test(artifactId)) throw new Error('出力IDが不正です。');
    const directory=path.join(artifactRoot,artifactId);
    const result=JSON.parse(await fs.readFile(path.join(directory,'render-result.json'),'utf8')) as {pptx:string};
    if(path.basename(result.pptx)!==result.pptx)throw new Error('出力ファイル名が不正です。');
    await serialized(()=>execute(executable,['--open',path.join(directory,result.pptx)],{timeout:30_000,windowsHide:true,maxBuffer:1_000_000}));
  }
  return {artifactRoot,nativeAvailable,render,open};
}
