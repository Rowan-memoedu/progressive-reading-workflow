import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReaderMath} from '../lib/reader-math.mjs';

test('publication normalizes only alternate formula wrappers and is idempotent',()=>{
  const text=String.raw`条件 \(r^2=x^2+y^2\)，以及 \[E=mc^2\]。`;
  const result=normalizeReaderMath(text);
  assert.equal(result.markdown,'条件 $r^2=x^2+y^2$，以及 $$E=mc^2$$。');
  assert.equal(result.report.inline_converted,1);assert.equal(result.report.display_converted,1);
  assert.equal(normalizeReaderMath(result.markdown).markdown,result.markdown);
});

test('nested Mermaid, literal code, destinations and existing math remain exact',()=>{
  const text=String.raw`- \(a+b\)
  - \\`;
  const code='- 例子\n  - ```mermaid\n    graph LR\n    A["\\(literal\\)"]-->B\n    ```\n- 保留 `\\(code\\)`、$\\text{\\(x\\)}$ 和 [文件](assets/\\(name\\).pdf)';
  assert.equal(normalizeReaderMath(code).markdown,code);
  assert.ok(normalizeReaderMath(text).markdown.startsWith('- $a+b$'));
});

test('frontmatter and escaped or incomplete wrappers are not rewritten',()=>{
  const source=String.raw`---
source_url: "https://example.org/\(source\)"
---
\\(escaped\\) 和 \(incomplete`;
  assert.equal(normalizeReaderMath(source).markdown,source);
});

test('escaped ordinary brackets and link labels stay literal while real TeX converts',()=>{
  const source=String.raw`[\[Related pages\]](https://example.test/related)
正文 \[普通说明\] 与 \[between input noise & output noise\]。
公式 \[a+b\]、\[x\]、\[\alpha\]。`;
  const output=normalizeReaderMath(source);
  assert.ok(output.markdown.includes(String.raw`[\[Related pages\]](https://example.test/related)`));
  assert.ok(output.markdown.includes(String.raw`\[普通说明\] 与 \[between input noise & output noise\]`));
  assert.ok(output.markdown.includes(String.raw`$$a+b$$、$$x$$、$$\alpha$$`));
  assert.equal(output.report.display_converted,3);
});

test('unpaired currency amounts are literal and do not consume later inline mathematics',()=>{
  const input='Pay $10 for a ticket or $100 for a pass. Next $x$ is a variable.\nKeep $10$ as math and `cost=$20` as code; [price](https://example.test/$30).';
  const result=normalizeReaderMath(input);
  assert.equal(result.markdown,'Pay \\$10 for a ticket or \\$100 for a pass. Next $x$ is a variable.\nKeep $10$ as math and `cost=$20` as code; [price](https://example.test/$30).');
  assert.equal(result.report.literal_currency_escaped,2);
  assert.equal(normalizeReaderMath(result.markdown).markdown,result.markdown);
});

test('bracketed reference prose with punctuation and links remains prose',()=>{
  const source=String.raw`Notes \[eg. [A](https://example.test/a "C++ workloads")/[B](https://example.test/b), research & planning\].`;
  assert.equal(normalizeReaderMath(source).markdown,source);
  assert.equal(normalizeReaderMath(String.raw`\[a+b\]`).markdown,'$$a+b$$');
});

test('text underscores are escaped only inside math text macros and remain idempotent',()=>{
  const source=String.raw`正文 field_name，$x_i+\text{sample_count}+\text{already\_safe}$。
$$\frac{a_b}{c_d}+\textbf{a_{nested}_label}$$
\(\text{other_metric}\) 与 \[\texttt{user_key}\]。`;
  const result=normalizeReaderMath(source);
  assert.equal(result.markdown,String.raw`正文 field_name，$x_i+\text{sample\_count}+\text{already\_safe}$。
$$\frac{a_b}{c_d}+\textbf{a\_{nested}\_label}$$
$\text{other\_metric}$ 与 $$\texttt{user\_key}$$。`);
  assert.equal(result.report.text_underscores_escaped,5);
  assert.equal(result.report.formula_content_unchanged,false);
  assert.equal(normalizeReaderMath(result.markdown).markdown,result.markdown);
});

test('nested math, code, source metadata, links and incomplete prose remain literal',()=>{
  const source=[
    '---', String.raw`source_title: '$\text{source_name}$'`, '---',
    String.raw`Math $\text{score_value $x_i$ and \(y_j\) and \ensuremath{z_k}}$.`,
    'Code `'+String.raw`$\text{code_name}$`+'` and [source](https://example.test/field_name).',
    '~~~tex', String.raw`$\text{literal_name}$`, '~~~'
  ].join('\n');
  const output=normalizeReaderMath(source).markdown;
  assert.ok(output.includes(String.raw`\text{score\_value $x_i$ and \(y_j\) and \ensuremath{z_k}}`));
  assert.ok(output.includes(String.raw`source_title: '$\text{source_name}$'`));
  assert.ok(output.includes(String.raw`$\text{code_name}$`));
  assert.ok(output.includes(String.raw`$\text{literal_name}$`));
});
