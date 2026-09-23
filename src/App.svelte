<script lang="ts">
  import { format, search } from "./search";

  let query = $state("");
  let results = $state<string[]>([]);
  let loading = $state(false);
  let error = $state("");
  let copied = $state<string | null>(null);

  // Each keystroke starts a search after a short pause; a newer one makes older answers stale,
  // so only the latest request's results are ever shown.
  let latest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function onInput() {
    const input = query;
    const id = ++latest;
    clearTimeout(timer);
    if (!input.trim()) {
      results = [];
      loading = false;
      return;
    }
    loading = true;
    timer = setTimeout(async () => {
      try {
        const records = await search(input);
        if (id !== latest) return;
        // Not searchable yet (e.g. a half-typed word was dropped): keep showing the last results.
        if (records) results = [...new Set(records.map(format))];
        error = "";
      } catch (e) {
        if (id !== latest) return;
        error = e instanceof Error ? e.message : String(e);
      } finally {
        if (id === latest) loading = false;
      }
    }, 150);
  }

  async function copy(address: string) {
    await navigator.clipboard.writeText(address);
    copied = address;
    setTimeout(() => {
      if (copied === address) copied = null;
    }, 1500);
  }
</script>

<main>
  <input
    type="search"
    bind:value={query}
    oninput={onInput}
    placeholder="Start typing an address, e.g. 350 5th Ave, New York NY"
    autocomplete="off"
    spellcheck="false"
    {@attach (el) => el.focus()}
  />

  {#if error}
    <p class="status">Something went wrong: {error}</p>
  {:else if query.trim() && !loading && results.length === 0}
    <p class="status">No matching addresses</p>
  {/if}

  <ul class:loading>
    {#each results as address (address)}
      <li>
        <span>{address}</span>
        <button type="button" onclick={() => copy(address)} aria-label="Copy {address}">
          {copied === address ? "Copied" : "Copy"}
        </button>
      </li>
    {/each}
  </ul>
</main>

<footer>
  Address data from <a href="https://openaddresses.io">OpenAddresses</a>, under each source's license.
  Queried in the browser with <a href="https://github.com/shivan2418/blockdb">blockdb</a>.
</footer>

<style>
  :global(body) {
    margin: 0;
    background: #fff;
    color: #1a1a1a;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }

  main {
    max-width: 640px;
    margin: 0 auto;
    padding: 18vh 16px 32px;
  }

  input {
    box-sizing: border-box;
    width: 100%;
    padding: 14px 22px;
    font: inherit;
    font-size: 17px;
    border: 1px solid #dcdcdc;
    border-radius: 999px;
    outline: none;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.06);
  }

  input:focus {
    border-color: #b5b5b5;
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.1);
  }

  ul {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    transition: opacity 0.15s;
  }

  ul.loading {
    opacity: 0.5;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 22px;
    border-radius: 12px;
  }

  li:hover {
    background: #f5f5f5;
  }

  button {
    flex: none;
    min-width: 68px;
    padding: 5px 12px;
    font: inherit;
    font-size: 13px;
    color: #444;
    background: #fff;
    border: 1px solid #dcdcdc;
    border-radius: 999px;
    cursor: pointer;
  }

  button:hover {
    border-color: #aaa;
  }

  footer {
    position: fixed;
    bottom: 12px;
    left: 0;
    right: 0;
    padding: 0 16px;
    text-align: center;
    font-size: 12px;
    color: #aaa;
  }

  footer a {
    color: inherit;
  }

  .status {
    margin: 16px 22px 0;
    color: #888;
    font-size: 14px;
  }
</style>
