// Tests for tools/model-filing.mjs and the catalog collection it reads.
// Run: node tools/model-filing.test.mjs
import assert from 'node:assert/strict';
import { fileModelsByCatalog, refRepo, buildIdOf, buildFacts, safetyRemoved } from './model-filing.mjs';
import { collectCatalog, mergeModels } from './aggregate-founders.mjs';

const families = [
  {
    id: 'gemma-4',
    members: [
      {
        id: 'e2b',
        aliases: ['gemma4:e2b-it-qat'],
        artifacts: [
          { engine: 'ollama', ref: 'gemma4:e2b', quant: 'Q4_K_M', by: 'google', attribution: 'vendor' },
          { engine: 'ollama', ref: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M', quant: 'Q4_K_M', by: 'unsloth', attribution: 'quantizer', base: 'google/gemma-4-E2B-it' },
          { engine: 'ollama', ref: 'hf.co/bartowski/google_gemma-4-E2B-it-GGUF:Q4_K_M', quant: 'Q4_K_M', by: 'bartowski', attribution: 'quantizer' },
          { engine: 'vllm', ref: 'google/gemma-4-E2B-it-qat-w4a16-ct', quant: 'W4A16', by: 'google', attribution: 'vendor' },
        ],
      },
      {
        id: '12b',
        artifacts: [
          { engine: 'ollama', ref: 'hf.co/unsloth/gemma-4-12B-it-qat-GGUF:Q4_K_M', quant: 'Q4_K_M', by: 'unsloth', attribution: 'quantizer' },
          { engine: 'ollama', ref: 'hf.co/unsloth/gemma-4-12b-it-GGUF:Q4_K_M', quant: 'Q4_K_M', by: 'unsloth', attribution: 'quantizer' },
        ],
      },
      {
        id: 'e2b~wwtcyberlab-abliterated',
        derivative: true,
        base: 'e2b',
        artifacts: [
          { engine: 'ollama', ref: 'hf.co/mradermacher/gemma-4-E2B-it-abliterated-GGUF:Q4_K_M', quant: 'Q4_K_M', by: 'mradermacher', attribution: 'derivative', base: 'WWTCyberLab/gemma-4-E2B-it-abliterated' },
        ],
      },
    ],
  },
];

const node = (runtime) => [{ node_did: 'did:epn:x', runtime }];

// 1. A build the catalog files today is filed there, whatever its gram signed;
//    the signed filing stays beside it.
{
  const models = [
    // signed under a member the catalog has retired
    { name: 'hf.co/bartowski/google_gemma-4-E2B-it-GGUF:Q4_K_M', family: 'gemma-4', member: 'e2b~bartowski', signed_family: 'gemma-4', signed_member: 'e2b~bartowski', nodes: node('ollama-host') },
    // a quant the catalog's ladder does not list, joined by its repo
    { name: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:IQ3_XXS', family: null, member: null, nodes: node('ollama-host') },
    // an engine's own tag, joined by alias
    { name: 'gemma4:e2b-it-qat', family: null, member: null, declared: { quantization: 'Q4_0' }, nodes: node('ollama') },
    // nothing names it: keeps what it signed
    { name: 'hf.co/someone/other-GGUF:Q4_K_M', family: 'gemma-4', member: 'e4b', nodes: node('ollama-host') },
  ];
  const out = fileModelsByCatalog(models, families);
  assert.equal(models[0].member, 'e2b', 'retired e2b~bartowski folds into e2b');
  assert.equal(models[0].signed_member, 'e2b~bartowski', 'the signed filing is kept as a note');
  assert.equal(models[0].filed_by, 'catalog_ref');
  assert.equal(models[1].member, 'e2b');
  assert.equal(models[1].filed_by, 'catalog_repo');
  assert.equal(models[1].quant, 'IQ3_XXS', 'the ref spells its own precision');
  assert.equal(models[2].member, 'e2b');
  assert.equal(models[2].filed_by, 'catalog_alias');
  assert.equal(models[3].member, 'e4b');
  assert.equal(models[3].filed_by, 'signed');
  assert.equal(out.refiled, 1);
}

// 2. A build's address is publisher-quant-engine.
{
  const models = [
    { name: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M', nodes: node('ollama-host') },
    { name: 'google/gemma-4-E2B-it-qat-w4a16-ct', nodes: node('vllm') },
    { name: 'gemma4:e2b', declared: { quantization: 'Q4_K_M' }, nodes: node('ollama') },
  ];
  fileModelsByCatalog(models, families);
  assert.equal(models[0].build, 'unsloth-q4_k_m-ollama');
  assert.equal(models[1].build, 'google-w4a16-vllm', 'a vLLM build carries the precision the catalog read');
  assert.equal(models[2].build, 'google-q4_k_m-ollama');
}

// 3. Two builds that share publisher, quant and engine get the words that tell
//    them apart, and a published address does not move.
{
  const a = { name: 'hf.co/unsloth/gemma-4-12B-it-qat-GGUF:Q4_K_M', nodes: node('ollama-host') };
  const b = { name: 'hf.co/unsloth/gemma-4-12b-it-GGUF:Q4_K_M', nodes: node('ollama-host') };
  fileModelsByCatalog([a, b], families);
  assert.equal(a.build, 'unsloth-q4_k_m-ollama-qat');
  assert.notEqual(a.build, b.build);
  assert.ok(b.build.startsWith('unsloth-q4_k_m-ollama-'));
  // Next run: b was published bare before a existed; it keeps its address.
  const a2 = { name: a.name, nodes: node('ollama-host') };
  const b2 = { name: b.name, nodes: node('ollama-host') };
  const prev = new Map([[b.name, { family: 'gemma-4', member: '12b', build: 'unsloth-q4_k_m-ollama' }]]);
  fileModelsByCatalog([a2, b2], families, prev);
  assert.equal(b2.build, 'unsloth-q4_k_m-ollama', 'a published address is kept');
  assert.notEqual(a2.build, b2.build);
}

// 4. Refs that differ only in case are two rows and two addresses.
{
  const fams = [{ id: 'qwen-2-5', members: [{ id: '0.5b', artifacts: [{ engine: 'ollama', ref: 'hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:q4_k_m', quant: 'Q4_K_M', by: 'Qwen' }] }] }];
  const x = { name: 'hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:q4_k_m', nodes: node('ollama-host') };
  const y = { name: 'hf.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF:Q4_K_M', nodes: node('ollama-host') };
  fileModelsByCatalog([x, y], fams);
  assert.equal(x.member, '0.5b');
  assert.equal(y.member, '0.5b');
  assert.notEqual(x.build, y.build);
}

// 5. Derivatives carry their lineage and a safety label when the name says so.
{
  const d = { name: 'hf.co/mradermacher/gemma-4-E2B-it-abliterated-GGUF:Q4_K_M', nodes: node('ollama-host') };
  fileModelsByCatalog([d], families);
  assert.equal(d.member, 'e2b~wwtcyberlab-abliterated');
  assert.equal(d.derivative, true);
  assert.equal(d.base_member, 'e2b');
  assert.equal(d.safety_removed, true);
  assert.equal(d.publisher, 'mradermacher');
  assert.equal(safetyRemoved('hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M'), false);
}

// 6. Ref shapes.
{
  assert.equal(refRepo('hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M'), 'unsloth/gemma-4-e2b-it-gguf');
  assert.equal(refRepo('google/gemma-4-E2B-it'), 'google/gemma-4-e2b-it');
  assert.equal(refRepo('gemma4:e2b'), null);
  const f = buildFacts({ name: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers', nodes: node('generation') }, null);
  assert.equal(buildIdOf({ name: 'Wan-AI/Wan2.1-T2V-1.3B-Diffusers' }, f), 'wan-ai-wan2.1-t2v-1.3b-diffusers-generation',
    'no precision known: the repo name stands in for it');
}

// 7. The newest filing of a family wins when grams on different builds report.
{
  const old = { proof_snapshot: { families: [{ id: 'gemma-4', members: [{ id: 'e2b~bartowski', artifacts: [{ ref: 'r1' }] }] }] } };
  const neu = { proof_snapshot: { families: [{ id: 'gemma-4', schema_version: 8, members: [{ id: 'e2b', artifacts: [{ ref: 'r1' }] }, { id: '9b~a-b', derivative: true, base: '9b', artifacts: [{ ref: 'r2' }] }] }] } };
  for (const order of [[old, neu], [neu, old]]) {
    const cat = collectCatalog(order);
    const ids = cat[0].members.map((m) => m.id);
    assert.deepEqual(ids, ['9b~a-b', 'e2b'], `retired ids never come back (${ids})`);
    assert.equal(cat[0].members[0].derivative, true);
    assert.equal(cat[0].members[0].base, '9b');
  }
}

// 8. A run with no catalog keeps the last one.
{
  const prev = { models: [{ slug: 's', name: 'n', provider_count: 1 }], families: [{ id: 'f', members: [] }] };
  const cur = { models: [], families: [] };
  assert.equal(mergeModels(prev, cur).families.length, 1);
}

console.log('model-filing tests passed');
