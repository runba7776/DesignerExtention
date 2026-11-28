import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutIssues } from '../server/render-bridge';
import { freeSystemPrompt } from '../core/free-prompts';

test('text PowerPoint set over another or past its box reaches the app as well-formed issues of this deck', () => {
  const issues = layoutIssues(
    [
      { slide: 4, kind: 'overlap', text: '月1.5トン', other: '売れ残りを寄付する' },
      { slide: 2, kind: 'notch', text: '一部の部署で試行' },
      { slide: 8, kind: 'edge', text: '現状の廃棄額は年2,900万円' },
      { slide: 9, kind: 'overflow', text: 'x'.repeat(80) },
      { slide: 0, kind: 'overflow', text: '範囲外のページ' },
      { slide: 3, kind: 'unknown', text: '知らない種類' },
      'not an object',
    ],
    9,
  );
  assert.deepEqual(issues, [
    { slide: 4, kind: 'overlap', text: '月1.5トン', other: '売れ残りを寄付する' },
    { slide: 2, kind: 'notch', text: '一部の部署で試行' },
    { slide: 8, kind: 'edge', text: '現状の廃棄額は年2,900万円' },
    { slide: 9, kind: 'overflow', text: 'x'.repeat(40) },
  ]);
  assert.deepEqual(layoutIssues(undefined, 9), []);
});

test('the PowerPoint renderer checks the drawn text and writes what remains for the app', () => {
  const source = readFileSync('native/Renderer.cs', 'utf8');
  assert.match(source, /CheckTextLayout\(slide, i \+ 1\);/);
  assert.match(source, /issues = Issues/);
  for (const kind of ['"overflow"', '"overlap"', '"edge"', '"notch"']) assert.ok(source.includes(kind), kind);
});

test('the HTML instructions keep text on a chevron clear of its cut-in and point', () => {
  assert.match(
    freeSystemPrompt('generate', { format: 'html', outputMode: 'presentation' }),
    /切り欠きや先端に文字がかからないようにします/,
  );
});
