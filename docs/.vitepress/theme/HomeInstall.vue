<template>
  <section class="ll-section">
    <h2>Install</h2>
    <p>
      Linear Lens 0.1.0 is published on
      <a href="https://open-vsx.org/extension/alliecatowo/linear-lens">Open VSX</a>, the registry
      used by Cursor, VSCodium and other VS Code forks. Open the Extensions view and search for
      <strong>Linear Lens</strong> (publisher <code>alliecatowo</code>). It is not on the Visual
      Studio Marketplace, and there are no GitHub releases yet.
    </p>
    <p>
      In stock VS Code, download the <code>.vsix</code> from the Open VSX page and run
      <strong>Extensions: Install from VSIX</strong>. To build it yourself:
    </p>
    <div class="language-sh"><pre><code>pnpm install
pnpm build
pnpm package    # produces linear-lens-&lt;version&gt;.vsix</code></pre></div>
    <p>
      Then run <strong>Linear Lens: Configure Workspace Slug</strong>, and see
      <a href="./guide/authentication">Authentication</a> for rich hovers. The full docs are under
      <a href="./guide/install">Guide</a> and <a href="./reference/settings">Settings</a>.
    </p>
  </section>
</template>
