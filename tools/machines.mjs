// THE MACHINE BEHIND A NUMBER, IN FULL (data/machines.json).
//
// A probe signs a class-sized description of its machine (OS, CPUs, RAM, card
// class, and from epn-daemon e9f1c13 the card and CPU names). The same gram
// ALSO signs resource benchmarks about that machine in its proof snapshot:
// the CPU's model string with its clock, physical cores, threads per core,
// sockets and caches, single- and multi-core throughput; the memory's
// bandwidth, latency and size; each card's name, memory, fp16 TFLOP/s and
// watts; the disk's read/write and IOPS. Those were published only for the
// grams online at the moment of an aggregate (data/mesh.json), and nothing
// joined them to the probes, so the table named a "Linux · no GPU · 4 CPUs"
// machine whose Xeon, clock and memory bandwidth were signed facts sitting in
// another file.
//
// This keeps, per gram, the newest VERIFIED benchmark of each resource, merged
// across runs (a gram that goes offline keeps its sheet), and sheetFor() picks
// the parts that describe the machine a given probe ran on: a CPU sheet only
// when its logical cores match, a card only when the probe had one of that
// memory, the memory only when its size matches.

import { existsSync, readFileSync } from 'node:fs';

export const MACHINES_PATH = 'data/machines.json';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const toISO = (ts) => (Number(ts) > 0 ? new Date(Number(ts) / 1e6).toISOString() : null);

/** "Intel(R) Xeon(R) CPU @ 2.20GHz" -> { name: "Intel Xeon", clock_ghz: 2.2 } */
export function cpuName(model) {
  if (!model) return { name: null, clock_ghz: null };
  const clock = model.match(/@\s*([\d.]+)\s*GHz/i);
  const name = model
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\s*@\s*[\d.]+\s*GHz/i, '')
    .replace(/\bCPU\b/g, '')
    .replace(/\s+\d+-Core Processor/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { name: name || null, clock_ghz: clock ? +clock[1] : null };
}

function cpuSheet(r) {
  const x = r.extra || {};
  const { name, clock_ghz } = cpuName(x.cpu_model);
  return {
    model: name, model_raw: x.cpu_model || null, clock_ghz,
    cores_logical: num(x.cores_logical), cores_physical: num(x.cores_physical),
    threads_per_core: num(x.threads_per_core), sockets: num(x.cpu_sockets),
    l2_kb: num(x.cache_l2_unified_kb), l3_mb: x.cache_l3_unified_kb ? r1(x.cache_l3_unified_kb / 1024) : null,
    single_core_hashes_per_sec: r1(num(r.value)), multi_core_hashes_per_sec: r1(num(x.multicore_hashes_per_sec)),
    sustained_ratio: r1(num(x.sustained_ratio)),
    method: x.payload || null,
  };
}

function memSheet(r) {
  const x = r.extra || {};
  return {
    total_gb: x.total_mb ? r1(x.total_mb / 1024) : null,
    bandwidth_gb_s: r.value > 0 ? r1(r.value / 1024) : null,
    latency_ns: r1(num(x.random_access_ns)),
    method: x.method || null,
  };
}

function gpuSheet(r) {
  const x = r.extra || {};
  return {
    name: x.name || null, memory_gb: x.mem_total_mb ? r1(x.mem_total_mb / 1024) : null,
    fp16_tflops: r1(num(r.value)), watts: r1(num(x.card_avg_watts)), tflops_per_watt: x.tflops_per_watt ? +(+x.tflops_per_watt).toFixed(3) : null,
    method: x.method || null,
  };
}

function storageSheet(r) {
  const x = r.extra || {};
  return {
    read_mb_s: r1(num(x.read_mbps)), write_mb_s: r1(num(x.write_mbps)),
    random_read_iops: x.random_read_4k_iops ? Math.round(x.random_read_4k_iops) : null,
    fs_type: x.fs_type || null, device_model: x.device_model || null,
  };
}

const SHEETS = { cpu: cpuSheet, mem: memSheet, gpu: gpuSheet, storage: storageSheet };

/**
 * buildMachines folds verified resource results into the previous file.
 * verified: [{ resource_type, signed_result }] already signature-checked.
 */
export function buildMachines(verified, previous = null, generatedAt = new Date().toISOString()) {
  const grams = { ...(previous?.grams || {}) };
  for (const v of verified) {
    const make = SHEETS[v.resource_type];
    const r = v.signed_result?.result;
    if (!make || !r?.node_did) continue;
    const g = (grams[r.node_did] ||= {});
    const at = toISO(r.ts);
    // One sheet per resource and machine: a card's sheet is per card name, a
    // CPU's per core count, so a home that moved machines keeps both.
    const sheet = { ...make(r), measured_at: at, measured_in: r.extra?.measured_in || null, signed: true };
    const slot = v.resource_type === 'gpu' ? `gpu:${sheet.name || '?'}`
      : v.resource_type === 'cpu' ? `cpu:${sheet.cores_logical || '?'}`
      : v.resource_type === 'mem' ? `mem:${Math.round(sheet.total_gb || 0)}`
      : `${v.resource_type}`;
    if (!g[slot] || (g[slot].measured_at || '') < (at || '')) g[slot] = sheet;
  }
  return {
    generated_at: generatedAt,
    note: 'Per gram, the newest verified resource benchmark of each part of its machine, from the signed proof snapshots. data/machines.json; tools/machines.mjs.',
    grams,
  };
}

export function readMachines() {
  if (!existsSync(MACHINES_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MACHINES_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** The signed parts of node_did's machine that match the probe's hardware. */
export function sheetFor(machines, nodeDID, hw) {
  const g = machines?.grams?.[nodeDID];
  if (!g || !hw) return null;
  const out = {};
  if (hw.cpus && g[`cpu:${hw.cpus}`]) out.cpu = g[`cpu:${hw.cpus}`];
  const ramBand = Math.round(hw.ram_gib || 0);
  const mem = Object.entries(g).find(([k, s]) => k.startsWith('mem:') && s.total_gb && Math.abs(s.total_gb - ramBand) <= Math.max(1, ramBand * 0.1));
  if (mem) out.memory = mem[1];
  const card = hw.gpu && hw.gpu !== 'none' && hw.gpu !== 'other';
  if (card) {
    const gpus = Object.entries(g).filter(([k]) => k.startsWith('gpu:')).map(([, s]) => s);
    const pick = gpus.find((s) => hw.gpu_model && s.name && s.name.toLowerCase().includes(hw.gpu_model.toLowerCase()))
      || gpus.find((s) => s.memory_gb && hw.vram_gib && Math.abs(s.memory_gb - hw.vram_gib) <= 1.5);
    if (pick) out.gpu = pick;
  }
  if (g.storage) out.storage = g.storage;
  return Object.keys(out).length ? out : null;
}
