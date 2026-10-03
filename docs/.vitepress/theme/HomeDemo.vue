<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { withBase } from "vitepress";

type Ref = {
  issue: { normalized: string };
  kind: "todo" | "raw" | "url";
  marker?: string;
  start: number;
  end: number;
};

const sample = `// TODO: ENG-123 retry with backoff when the queue is full
// Fixed in ENG-98, see https://linear.app/acme/issue/ENG-77/flaky-test
function drain() {
  // FIXME ENG-124 handle null user
  const debug = true; // not a BUG marker: "debug" is a whole word check
}

- [ ] ENG-130 add a migration
- [x] ENG-131 shipped
git branch: allie/eng-142-fix-parser`;

const text = ref(sample);
const ready = ref(false);
const failed = ref(false);
let scan: ((t: string) => Ref[]) | null = null;

onMounted(() => {
  const s = document.createElement("script");
  s.src = withBase("/demo/scan.js");
  s.onload = () => {
    scan = (window as any).LinearLensScan;
    ready.value = !!scan;
    failed.value = !scan;
  };
  s.onerror = () => (failed.value = true);
  document.head.appendChild(s);
});

const refs = computed<Ref[]>(() => (ready.value && scan ? scan(text.value) : []));

type Part = { t: string; ref?: Ref };
const parts = computed<Part[]>(() => {
  const out: Part[] = [];
  let at = 0;
  for (const r of refs.value) {
    if (r.start > at) out.push({ t: text.value.slice(at, r.start) });
    out.push({ t: text.value.slice(r.start, r.end), ref: r });
    at = r.end;
  }
  out.push({ t: text.value.slice(at) });
  return out;
});

const problems = computed(() => refs.value.filter((r) => r.kind === "todo"));
const kindLabel = { todo: "Problem", raw: "link + hover", url: "link + hover" } as const;
</script>

<template>
  <section class="ll-section">
    <h2>Try the scanner</h2>
    <p>
      This runs the extension's own reference scanner (<code>src/parser.ts</code>) in your
      browser. Edit the text. Every reference links and hovers; only references bound to a
      <code>TODO</code>, <code>FIXME</code>, <code>BUG</code>, <code>HACK</code> marker or an
      unchecked task become Problems. Live hover cards need your Linear account, so they are not
      part of this demo.
    </p>
    <div class="demo">
      <div class="pane">
        <div class="bar"><span>Input</span></div>
        <textarea v-model="text" spellcheck="false" rows="11" aria-label="Sample text to scan"></textarea>
      </div>
      <div class="pane">
        <div class="bar"><span>What Linear Lens sees</span></div>
        <pre class="out" aria-live="polite"><template v-for="(p, i) in parts" :key="i"><span v-if="p.ref" :class="['ref', p.ref.kind]" :title="kindLabel[p.ref.kind]">{{ p.t }}</span><template v-else>{{ p.t }}</template></template></pre>
        <div class="summary" v-if="ready">
          {{ refs.length }} reference{{ refs.length === 1 ? "" : "s" }},
          {{ problems.length }} in the Problems panel
        </div>
        <div class="summary" v-else-if="failed">The demo script could not be loaded.</div>
        <div class="summary" v-else>Loading scanner...</div>
      </div>
    </div>
    <ul class="legend">
      <li><span class="ref todo">todo</span> shown in Problems</li>
      <li><span class="ref raw">raw</span> link and hover only</li>
      <li><span class="ref url">url</span> linear.app URL, link and hover only</li>
    </ul>
  </section>
</template>

<style scoped>
.demo {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 800px) {
  .demo {
    grid-template-columns: 1fr;
  }
}
.pane {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
  min-width: 0;
}
.bar {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--vp-c-text-2);
  border-bottom: 1px solid var(--vp-c-divider);
}
textarea,
.out {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 12px;
  font: 13px/1.6 var(--vp-font-family-mono);
  color: var(--vp-c-text-1);
  background: transparent;
  border: 0;
  resize: vertical;
  white-space: pre-wrap;
  word-break: break-word;
  min-height: 240px;
}
textarea:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: -2px;
}
.ref {
  border-bottom: 1px dotted var(--vp-c-brand-1);
  border-radius: 2px;
  padding: 0 1px;
}
.ref.todo {
  background: color-mix(in srgb, var(--vp-c-warning-1) 28%, transparent);
  border-bottom: 2px solid var(--vp-c-warning-1);
}
.ref.url {
  border-bottom-style: solid;
}
.summary {
  padding: 8px 12px;
  font-size: 13px;
  color: var(--vp-c-text-2);
  border-top: 1px solid var(--vp-c-divider);
}
.legend {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  padding: 0;
  margin: 12px 0 0;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.legend li {
  margin: 0;
}
</style>
