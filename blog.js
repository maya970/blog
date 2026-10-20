const OWNER = "qZffGaYkZh-x3lfH6NYXthe4wmps62DKS_I3gAuzEwY";
const APP = "PermaBlog";
const LEGACY_APP = "PermaNotes";
const PAGE_SIZE = 8;
const MAX_BYTES = 100 * 1024;
const GQL_ENDPOINTS = ["https://arweave.net/graphql", "https://arweave-search.goldsky.com/graphql"];
const UPLOAD_URL = "https://up.arweave.net/tx";
const WALLET_KEY = "permablog-wallet";
const NICK_KEY = "permablog-nick";
const VISIT_KEY = "permablog-visits";
const READ_KEY = "permablog-reads";
const PENDING_KEY = "permablog-pending";

const DEFAULT_PROFILE = {
  title: "marco99168的博客",
  nick: "marco99168",
  signature: "把记事本里的字，改成谁都能翻开的博客。",
  announcement: "这里的博文对所有人公开。从前加密锁住的那一页，仍然不会出现。",
  location: "网上",
  links: [
    { name: "Arweave", href: "https://arweave.net" },
    {
      name: "旧版记事本",
      href: "https://3koyh5a4opdjecsqtpkkiu5vl744jglvfo2o7b7nsbwi7n5cmqcq.arweave.net/2p2D9BxzxpIKUJvUpFO1X_nEmXUrtO-H7ZBsj7eiZAU",
    },
  ],
};

const state = {
  posts: [],
  comments: [],
  guestbook: [],
  profile: { ...DEFAULT_PROFILE, links: DEFAULT_PROFILE.links.map((item) => ({ ...item })) },
  loaded: false,
  loading: false,
  error: "",
  walletMode: "",
  jwk: null,
  address: "",
  uploading: false,
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(),
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatTime(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function dayKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthKey(day) {
  return day.slice(0, 7);
}

function monthLabel(key) {
  const [y, m] = key.split("-");
  return `${y}年${Number(m)}月`;
}

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = `statusbar${kind ? ` ${kind}` : ""}`;
}

function parseRoute() {
  let hash = location.hash.replace(/^#/, "") || "/";
  try {
    hash = decodeURIComponent(hash);
  } catch {
    /* keep the raw hash */
  }
  if (!hash.startsWith("/")) hash = `/${hash}`;
  const qIndex = hash.indexOf("?");
  const path = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
  const params = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : "");
  return { parts: path.split("/").filter(Boolean), params };
}

function bumpVisits() {
  const today = dayKey(Math.floor(Date.now() / 1000));
  let data = { n: 0, day: "" };
  try {
    data = JSON.parse(localStorage.getItem(VISIT_KEY) || "") || data;
  } catch {
    data = { n: 0, day: "" };
  }
  if (data.day !== today) {
    data.n = (Number(data.n) || 0) + 1;
    data.day = today;
    localStorage.setItem(VISIT_KEY, JSON.stringify(data));
  }
  return data.n || 1;
}

function readCount(id, increment) {
  let map = {};
  try {
    map = JSON.parse(localStorage.getItem(READ_KEY) || "{}");
  } catch {
    map = {};
  }
  if (increment) {
    map[id] = (map[id] || 0) + 1;
    localStorage.setItem(READ_KEY, JSON.stringify(map));
  }
  return map[id] || 0;
}

function renderRich(text) {
  const escaped = escapeHtml(text || "");
  const linked = escaped.replace(
    /((https?:\/\/|www\.)[^\s<]+|[a-z0-9.-]+\.(?:com|net|org|cn)(?:\/[^\s<]*)?)/gi,
    (raw) => {
      const href = raw.startsWith("http") ? raw : `https://${raw}`;
      return `<a href="${href}" target="_blank" rel="noopener">${raw}</a>`;
    },
  );
  const blocks = linked.split(/\n{2,}/).filter((part) => part.length);
  if (!blocks.length) return "<p>这篇博文还没有正文。</p>";
  return blocks.map((part) => `<p>${part.replace(/\n/g, "<br>")}</p>`).join("");
}

function excerptOf(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= 180) return { html: renderRich(text), more: false };
  return { html: `<p>${escapeHtml(flat.slice(0, 160))}…</p>`, more: true };
}

function makeTitle(entry) {
  if (entry.title) return entry.title;
  const first = String(entry.content || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return entry.kind === "diary" ? `${entry.date} 的日记` : entry.category || "无题";
  const cleaned = first.replace(/^[\d]+[.、)\s]+/, "").replace(/\s+/g, " ");
  if (cleaned.length >= 4) return cleaned.length > 28 ? `${cleaned.slice(0, 28)}…` : cleaned;
  return entry.kind === "diary" ? `${entry.date} 的日记` : `${entry.category || "随笔"}${entry.page ? ` · 第${entry.page}页` : ""}`;
}

async function gql(query, variables) {
  let lastError;
  for (const endpoint of GQL_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw new Error(`索引请求失败 (${response.status})`);
      const payload = await response.json();
      if (payload.errors?.length) throw new Error(payload.errors[0].message || "索引错误");
      return payload.data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("暂时连不上 Arweave");
}

const LIST_QUERY = `
  query List($after: String, $tags: [TagFilter!]!) {
    transactions(first: 50, after: $after, sort: HEIGHT_DESC, tags: $tags) {
      pageInfo { hasNextPage }
      edges {
        cursor
        node { id owner { address } block { timestamp } tags { name value } }
      }
    }
  }
`;

async function listTransactions(tags) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < 8; page += 1) {
    const data = await gql(LIST_QUERY, { after, tags });
    const edges = data.transactions.edges || [];
    nodes.push(...edges.map((edge) => edge.node));
    if (!data.transactions.pageInfo.hasNextPage || !edges.length) break;
    after = edges.at(-1).cursor;
  }
  return nodes;
}

async function mapPool(items, limit, worker) {
  const result = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return result;
}

function tagMap(node) {
  const map = new Map();
  for (const tag of node.tags || []) map.set(tag.name, tag.value);
  return map;
}

function fromOwner(node) {
  return (node.owner?.address || tagMap(node).get("Owner")) === OWNER;
}

function canWrite() {
  return state.address === OWNER;
}

async function fetchJson(id) {
  const response = await fetch(`https://arweave.net/${id}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`读不到 ${id}`);
  return response.json();
}

function logicalIdOf(post) {
  if (post.logicalId) return post.logicalId;
  if (post.kind === "diary") return `diary:${post.date || ""}`;
  if (post.kind === "notepad") return `notepad:${post.category}:${post.page || 0}`;
  const raw = String(post.postId || post.id || "");
  if (raw.startsWith("post:") || raw.startsWith("diary:") || raw.startsWith("notepad:")) return raw;
  return `post:${raw}`;
}

function legacyPost(node, data, tags) {
  if (data?.encrypted === true || tags.get("Encrypted") === "true") return null;
  const content = String(data?.content || "");
  if (!content.trim()) return null;
  const kind = data.type || tags.get("Type") || "";
  const ts = Number(node.block?.timestamp) || Number(tags.get("Unix-Time")) || Math.floor(Date.parse(data.updated || "") / 1000) || 0;
  const date = data.date || tags.get("Date") || "";
  const day = kind === "diary" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : dayKey(ts || Math.floor(Date.now() / 1000));
  const category = kind === "diary" ? "日记" : data.notebookName || tags.get("Notebook-Name") || "随笔";
  const entry = {
    id: node.id,
    kind,
    category,
    content,
    date,
    page: Number(data.page || tags.get("Page") || 0),
    timestamp: ts,
    revisedAt: ts,
    legacy: true,
  };
  entry.logicalId = logicalIdOf(entry);
  entry.title = makeTitle(entry);
  entry.day = day;
  entry.month = monthKey(day);
  return entry;
}

function blogPost(node, data, tags) {
  const content = String(data?.content || "");
  if (!content.trim()) return null;
  const revisedAt = Number(data.updatedAt) || Number(node.block?.timestamp) || Number(tags.get("Unix-Time")) || 0;
  const timestamp = Number(data.createdAt) || revisedAt;
  const day = dayKey(timestamp || Math.floor(Date.now() / 1000));
  const rawId = data.logicalId || data.postId || tags.get("Post-Id") || node.id;
  return {
    id: node.id,
    postId: rawId,
    logicalId: logicalIdOf({ postId: rawId, id: node.id, kind: "post" }),
    kind: "post",
    title: data.title || tags.get("Title") || "无题",
    category: data.category || tags.get("Category") || "随笔",
    content,
    timestamp,
    revisedAt,
    day,
    month: monthKey(day),
    legacy: false,
  };
}

function settlePosts(list, deletes) {
  const map = new Map();
  for (const post of list) {
    const key = logicalIdOf(post);
    post.logicalId = key;
    const prev = map.get(key);
    if (!prev) {
      post.versionIds = [post.id];
      map.set(key, post);
      continue;
    }
    const prevRev = prev.revisedAt || prev.timestamp || 0;
    const nextRev = post.revisedAt || post.timestamp || 0;
    const winner = nextRev >= prevRev ? post : prev;
    winner.versionIds = [...new Set([...(prev.versionIds || [prev.id]), post.id])];
    winner.logicalId = key;
    map.set(key, winner);
  }
  const deletedAt = new Map();
  for (const item of deletes || []) {
    if (!item?.postId) continue;
    const ts = Number(item.timestamp) || 0;
    if (ts >= (deletedAt.get(item.postId) || 0)) deletedAt.set(item.postId, ts);
  }
  return Array.from(map.values())
    .filter((post) => {
      const ts = deletedAt.get(post.logicalId) || 0;
      return !(ts && ts >= (post.revisedAt || post.timestamp || 0));
    })
    .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
}

function findPost(id) {
  if (!id) return null;
  return state.posts.find((post) => post.id === id || post.logicalId === id || post.postId === id || post.versionIds?.includes(id)) || null;
}

function loadPending() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function savePending(list) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list.slice(0, 40)));
}

function rememberPending(item) {
  const list = loadPending().filter((entry) => entry.id !== item.id);
  list.unshift(item);
  savePending(list);
}

async function loadBlog() {
  if (state.loading) return;
  state.loading = true;
  setStatus("正在从链上读取博文…");
  try {
    const [legacyNodes, blogNodes] = await Promise.all([
      listTransactions([
        { name: "App-Name", values: [LEGACY_APP] },
        { name: "Owner", values: [OWNER] },
      ]),
      listTransactions([
        { name: "App-Name", values: [APP] },
        { name: "Owner", values: [OWNER] },
      ]),
    ]);

    const legacyBodies = await mapPool(
      legacyNodes.filter((node) => fromOwner(node) && tagMap(node).get("Encrypted") !== "true"),
      4,
      async (node) => {
        try {
          return { node, data: await fetchJson(node.id) };
        } catch {
          return null;
        }
      },
    );
    const blogBodies = await mapPool(blogNodes.filter(fromOwner), 4, async (node) => {
      try {
        return { node, data: await fetchJson(node.id) };
      } catch {
        return null;
      }
    });

    const posts = [];
    const comments = [];
    const guestbook = [];
    const deletes = [];
    let profile = null;

    for (const item of legacyBodies) {
      if (!item?.data || item.data.schema !== "permanotes/1") continue;
      const post = legacyPost(item.node, item.data, tagMap(item.node));
      if (post) posts.push(post);
    }

    for (const item of blogBodies) {
      if (!item?.data) continue;
      const tags = tagMap(item.node);
      const type = item.data.type || tags.get("Type");
      const ts = Number(item.node.block?.timestamp) || Number(tags.get("Unix-Time")) || 0;
      if (type === "post") {
        const post = blogPost(item.node, item.data, tags);
        if (post) posts.push(post);
      } else if (type === "comment" || type === "guestbook") {
        const text = String(item.data.content || "").trim();
        if (!text) continue;
        const entry = {
          id: item.node.id,
          postId: item.data.postId || tags.get("Post-Id") || "",
          nick: item.data.nick || tags.get("Nick") || "访客",
          content: text,
          timestamp: ts,
          owner: item.node.owner?.address || "",
        };
        if (type === "guestbook") guestbook.push(entry);
        else comments.push(entry);
      } else if (type === "delete") {
        const postId = item.data.postId || tags.get("Post-Id") || "";
        if (postId) deletes.push({ id: item.node.id, postId, timestamp: Number(item.data.updatedAt) || ts });
      } else if (type === "profile") {
        if (!profile || ts >= profile.timestamp) {
          profile = { ...item.data, timestamp: ts };
        }
      }
    }

    const known = new Set([
      ...posts.map((post) => post.id),
      ...comments.map((item) => item.id),
      ...guestbook.map((item) => item.id),
      ...deletes.map((item) => item.id),
    ]);
    const pending = loadPending().filter((item) => item.owner === OWNER && !known.has(item.id));
    for (const item of pending) {
      if (item.recordType === "post") posts.push(item);
      else if (item.recordType === "comment") comments.push(item);
      else if (item.recordType === "guestbook") guestbook.push(item);
      else if (item.recordType === "delete") deletes.push(item);
      else if (item.recordType === "profile") profile = item;
    }
    savePending(pending);

    state.posts = settlePosts(posts, deletes);
    if (state.posts[0]?.month) {
      const [year, month] = state.posts[0].month.split("-");
      state.calYear = Number(year);
      state.calMonth = Number(month) - 1;
    }
    state.comments = comments.sort((a, b) => a.timestamp - b.timestamp);
    state.guestbook = guestbook.sort((a, b) => b.timestamp - a.timestamp);
    if (profile) {
      state.profile = {
        ...DEFAULT_PROFILE,
        title: profile.title || DEFAULT_PROFILE.title,
        nick: profile.nick || DEFAULT_PROFILE.nick,
        signature: profile.signature || DEFAULT_PROFILE.signature,
        announcement: profile.announcement || DEFAULT_PROFILE.announcement,
        location: profile.location || DEFAULT_PROFILE.location,
        links: DEFAULT_PROFILE.links.map((item) => ({ ...item })),
      };
    }
    state.loaded = true;
    state.error = "";
    setStatus(`已公开 ${state.posts.length} 篇博文。`, "ok");
    render();
  } catch (error) {
    state.error = error.message || "加载失败";
    setStatus(state.error, "err");
    render();
  } finally {
    state.loading = false;
  }
}

function commentsFor(post) {
  const ids = new Set([post.id, post.logicalId, post.postId, ...(post.versionIds || [])].filter(Boolean));
  return state.comments.filter((item) => ids.has(item.postId));
}

function timeLabel(post) {
  const published = `发表于 ${formatTime(post.timestamp)}`;
  if ((post.revisedAt || 0) > (post.timestamp || 0) + 60) return `${published} · 修改于 ${formatTime(post.revisedAt)}`;
  return published;
}

function ownerActions(post) {
  if (!canWrite()) return "";
  return `<span class="manage"><a href="#/edit/${encodeURIComponent(post.id)}">修改</a><button type="button" class="linkish" data-delete="${escapeHtml(post.id)}">删除</button></span>`;
}

function applyProfile() {
  const profile = state.profile;
  $("blog-title").textContent = profile.title;
  $("blog-sign").textContent = profile.signature;
  document.title = profile.title;
  $("profile-nick").textContent = profile.nick;
  $("profile-sign").textContent = profile.signature;
  $("profile-location").textContent = profile.location;
  $("announce").textContent = profile.announcement;
  $("copyright-line").textContent = `${profile.title} · 页面对所有人公开 · 博文保存在 Arweave`;
  $("stat-posts").textContent = state.loaded ? String(state.posts.length) : "–";
  $("stat-comments").textContent = state.loaded ? String(state.comments.length + state.guestbook.length) : "–";
  $("stat-visits").textContent = String(bumpVisits());
  const earliest = state.posts.at(-1);
  $("stat-since").textContent = earliest ? earliest.day : "–";

  const cats = new Map();
  for (const post of state.posts) cats.set(post.category, (cats.get(post.category) || 0) + 1);
  $("side-cats").innerHTML = Array.from(cats.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
    .map(
      ([name, count]) =>
        `<li><a href="#/cat/${encodeURIComponent(name)}">${escapeHtml(name)} <span class="count">(${count})</span></a></li>`,
    )
    .join("") || `<li><span>还没有分类</span></li>`;

  const months = new Map();
  for (const post of state.posts) months.set(post.month, (months.get(post.month) || 0) + 1);
  $("side-archive").innerHTML = Array.from(months.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(
      ([key, count]) =>
        `<li><a href="#/month/${key}">${monthLabel(key)} <span class="count">(${count})</span></a></li>`,
    )
    .join("") || `<li><span>还没有归档</span></li>`;

  $("side-recent").innerHTML = state.posts
    .slice(0, 8)
    .map((post) => `<li><a href="#/post/${encodeURIComponent(post.id)}" title="${escapeHtml(post.title)}">${escapeHtml(post.title)}</a></li>`)
    .join("") || `<li><span>还没有博文</span></li>`;

  $("side-links").innerHTML = profile.links
    .map((link) => `<li><a href="${escapeHtml(link.href)}" target="_blank" rel="noopener">${escapeHtml(link.name)}</a></li>`)
    .join("");

  renderCalendar();
  $("nav-write").hidden = !canWrite();
  const active = parseRoute().parts[0] || "home";
  document.querySelectorAll(".nav-links a").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === active || (active === "cat" && link.dataset.nav === "home") || (active === "month" && link.dataset.nav === "home") || (active === "day" && link.dataset.nav === "home") || (active === "search" && link.dataset.nav === "home") || (active === "post" && link.dataset.nav === "home"));
  });
}

function renderCalendar() {
  const year = state.calYear;
  const month = state.calMonth;
  const first = new Date(year, month, 1);
  const start = first.getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const posted = new Set(state.posts.map((post) => post.day));
  const today = dayKey(Math.floor(Date.now() / 1000));
  const route = parseRoute();
  const selected = route.parts[0] === "day" ? route.parts[1] : "";
  let cells = "";
  for (let i = 0; i < start; i += 1) cells += `<button type="button" disabled></button>`;
  for (let day = 1; day <= days; day += 1) {
    const key = `${year}-${pad(month + 1)}-${pad(day)}`;
    const cls = [posted.has(key) ? "has" : "", key === today || key === selected ? "on" : ""].filter(Boolean).join(" ");
    cells += `<button type="button" class="${cls}" data-day="${key}">${day}</button>`;
  }
  $("calendar").innerHTML = `
    <div class="cal-head">
      <button type="button" data-cal="-1" aria-label="上个月">‹</button>
      <span>${year}年${month + 1}月</span>
      <button type="button" data-cal="1" aria-label="下个月">›</button>
    </div>
    <div class="cal-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
    <div class="cal-grid">${cells}</div>
  `;
}

function filterPosts() {
  const { parts, params } = parseRoute();
  let items = state.posts.slice();
  let label = "";
  if (parts[0] === "cat") {
    const name = parts[1] || "";
    items = items.filter((post) => post.category === name);
    label = `分类：${name}`;
  } else if (parts[0] === "month") {
    items = items.filter((post) => post.month === parts[1]);
    label = `归档：${monthLabel(parts[1] || "")}`;
  } else if (parts[0] === "day") {
    items = items.filter((post) => post.day === parts[1]);
    label = `日期：${parts[1] || ""}`;
  } else if (parts[0] === "search") {
    const q = (params.get("q") || "").trim();
    const needle = q.toLowerCase();
    items = needle ? items.filter((post) => `${post.title}\n${post.category}\n${post.content}`.toLowerCase().includes(needle)) : [];
    label = q ? `搜索：${q}` : "搜索";
  }
  return { items, label };
}

function articleCard(post) {
  const piece = excerptOf(post.content);
  const comments = commentsFor(post).length;
  const reads = readCount(post.logicalId || post.id, false);
  return `
    <article class="article">
      <h2>
        <a class="cat" href="#/cat/${encodeURIComponent(post.category)}">[${escapeHtml(post.category)}]</a>
        <a href="#/post/${encodeURIComponent(post.id)}">${escapeHtml(post.title)}</a>
      </h2>
      <p class="time">${timeLabel(post)}</p>
      <div class="excerpt">${piece.html}</div>
      ${piece.more ? `<a class="more" href="#/post/${encodeURIComponent(post.id)}">阅读全文&gt;&gt;</a>` : ""}
      <div class="foot">
        <a href="#/post/${encodeURIComponent(post.id)}">阅读(${reads})</a>
        <a href="#/post/${encodeURIComponent(post.id)}">评论(${comments})</a>
        <a href="#/cat/${encodeURIComponent(post.category)}">分类：${escapeHtml(post.category)}</a>
        ${ownerActions(post)}
      </div>
    </article>
  `;
}

function pager(total, page, base) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages <= 1) return "";
  const buttons = [];
  buttons.push(`<button type="button" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>`);
  for (let i = 1; i <= pages; i += 1) {
    buttons.push(`<button type="button" data-page="${i}" data-base="${escapeHtml(base)}" ${i === page ? 'aria-current="page"' : ""}>${i}</button>`);
  }
  buttons.push(`<button type="button" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button>`);
  return `<div class="pager">${buttons.join("")}</div>`;
}

function pageBase() {
  const { parts, params } = parseRoute();
  if (!parts.length) return "#/";
  if (parts[0] === "search") return `#/search?q=${encodeURIComponent(params.get("q") || "")}`;
  return `#/${parts.map(encodeURIComponent).join("/")}`;
}

function renderList() {
  if (!state.loaded) {
    if (state.error) {
      return `<div class="empty">${escapeHtml(state.error)}<br><button class="btn" type="button" id="retry-btn">重新加载</button></div>`;
    }
    return `<article class="article"><h2>正在从链上取出博文</h2><p class="excerpt">稍等一下，记事本里公开的文字就要排好。</p></article>`;
  }
  const { items, label } = filterPosts();
  const page = Math.max(1, Number(parseRoute().params.get("p") || 1));
  const start = (page - 1) * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);
  const bar = label
    ? `<div class="filter-bar">${escapeHtml(label)} · ${items.length} 篇 <a href="#/">查看全部</a></div>`
    : "";
  if (!slice.length) {
    return `${bar}<div class="empty">${label ? "这一栏还没有博文。" : "还没有公开的博文。"}</div>`;
  }
  return `${bar}${slice.map(articleCard).join("")}${pager(items.length, page, pageBase())}`;
}

let lastCountedPost = "";

function renderPost() {
  const id = parseRoute().parts[1];
  const index = state.posts.findIndex((post) => post.id === id || post.logicalId === id || post.versionIds?.includes(id));
  const post = state.posts[index];
  if (!post) return `<div class="empty">没有找到这篇博文。<a href="#/">回首页</a></div>`;
  const reads = readCount(post.logicalId || post.id, lastCountedPost !== post.logicalId);
  lastCountedPost = post.logicalId || post.id;
  const comments = commentsFor(post);
  const newer = state.posts[index - 1];
  const older = state.posts[index + 1];
  const nick = localStorage.getItem(NICK_KEY) || state.profile.nick;
  return `
    <article class="article">
      <h2>
        <a class="cat" href="#/cat/${encodeURIComponent(post.category)}">[${escapeHtml(post.category)}]</a>
        ${escapeHtml(post.title)}
      </h2>
      <p class="time">${timeLabel(post)} · 阅读(${reads}) · 评论(${comments.length})</p>
      <div class="prose">${renderRich(post.content)}</div>
      <div class="foot">
        <a href="#/cat/${encodeURIComponent(post.category)}">分类：${escapeHtml(post.category)}</a>
        <a href="https://arweave.net/${encodeURIComponent(post.id)}" target="_blank" rel="noopener">链上原文</a>
        ${ownerActions(post)}
      </div>
    </article>
    <div class="neighbor">
      <span>${newer ? `<a href="#/post/${encodeURIComponent(newer.id)}">‹ 上一篇 ${escapeHtml(newer.title)}</a>` : ""}</span>
      <span>${older ? `<a href="#/post/${encodeURIComponent(older.id)}">${escapeHtml(older.title)} 下一篇 ›</a>` : ""}</span>
    </div>
    <section class="board">
      <h2 class="page-title">读者评论 (${comments.length})</h2>
      ${
        comments.length
          ? comments
              .map(
                (item) => `
            <div class="comment">
              <div><span class="who">${escapeHtml(item.nick)}</span><span class="when">${formatTime(item.timestamp)}</span></div>
              <p class="body">${escapeHtml(item.content)}</p>
            </div>`,
              )
              .join("")
          : `<p class="hint">还没有评论。</p>`
      }
      ${
        canWrite()
          ? `<form class="comment-box" data-form="comment" style="margin-top:14px">
        <div class="form-row">
          <label for="comment-nick">昵称</label>
          <input id="comment-nick" name="nick" type="text" maxlength="16" value="${escapeHtml(nick)}" required />
        </div>
        <div class="form-row">
          <label for="comment-body">评论</label>
          <textarea id="comment-body" name="content" maxlength="800" required></textarea>
        </div>
        <button class="btn-pub" type="submit">发表评论</button>
      </form>`
          : ""
      }
    </section>
  `;
}

function renderCatalog() {
  const groups = new Map();
  for (const post of state.posts) {
    if (!groups.has(post.category)) groups.set(post.category, []);
    groups.get(post.category).push(post);
  }
  const blocks = Array.from(groups.entries())
    .map(
      ([name, posts]) => `
      <section class="catalog-block">
        <h3>${escapeHtml(name)} (${posts.length})</h3>
        <ul>
          ${posts
            .map(
              (post) => `
            <li>
              <a href="#/post/${encodeURIComponent(post.id)}">${escapeHtml(post.title)}</a>
              <time>${post.day}</time>
            </li>`,
            )
            .join("")}
        </ul>
      </section>`,
    )
    .join("");
  return `<div class="catalog"><h2 class="page-title">博文目录</h2>${blocks || `<div class="empty">目录还是空的。</div>`}</div>`;
}

function renderAbout() {
  const profile = state.profile;
  return `
    <section class="about">
      <h2 class="page-title">关于博主</h2>
      <p>你好，我是 <strong>${escapeHtml(profile.nick)}</strong>。</p>
      <p>${escapeHtml(profile.signature)}</p>
      <p>这个博客是从以前的链上记事本改过来的。日记和分类本里没有加密的文字，现在谁打开都能看。加密保存的内容不会出现在这里。</p>
      <p>你现在看到的页面放在 GitHub 上。博文、评论、留言和资料都写在 Arweave 里，打开页面时再从链上读出来。改过或删掉的博文，页面上只留最新结果；旧的那一笔交易还在链上。</p>
      <p>所在：${escapeHtml(profile.location)}</p>
    </section>
  `;
}

function renderBoard() {
  const nick = localStorage.getItem(NICK_KEY) || state.profile.nick;
  const list = state.guestbook
    .map(
      (item) => `
      <div class="comment">
        <div><span class="who">${escapeHtml(item.nick)}</span><span class="when">${formatTime(item.timestamp)}</span></div>
        <p class="body">${escapeHtml(item.content)}</p>
      </div>`,
    )
    .join("");
  return `
    <section class="board">
      <h2 class="page-title">留言板</h2>
      ${list || `<p class="hint">留言板还空着。</p>`}
      ${
        canWrite()
          ? `<form class="comment-box" data-form="guestbook" style="margin-top:14px">
        <div class="form-row">
          <label for="guest-nick">昵称</label>
          <input id="guest-nick" name="nick" type="text" maxlength="16" value="${escapeHtml(nick)}" required />
        </div>
        <div class="form-row">
          <label for="guest-body">留言</label>
          <textarea id="guest-body" name="content" maxlength="800" required></textarea>
        </div>
        <button class="btn-pub" type="submit">写下留言</button>
      </form>`
          : ""
      }
    </section>
  `;
}

function renderWrite() {
  if (!canWrite()) return renderList();
  const editing = parseRoute().parts[0] === "edit" ? findPost(parseRoute().parts[1]) : null;
  if (parseRoute().parts[0] === "edit" && !editing) return `<div class="empty">没有找到要修改的博文。<a href="#/">回首页</a></div>`;
  const categories = Array.from(new Set(state.posts.map((post) => post.category))).sort((a, b) => a.localeCompare(b, "zh"));
  const options = categories.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
  const profileForm = editing
    ? ""
    : `
      <h2 class="page-title" style="margin-top:22px">博客资料</h2>
      <form data-form="profile">
        <div class="form-row"><label for="pf-title">博客名</label><input id="pf-title" name="title" type="text" maxlength="24" value="${escapeHtml(state.profile.title)}" /></div>
        <div class="form-row"><label for="pf-nick">昵称</label><input id="pf-nick" name="nick" type="text" maxlength="16" value="${escapeHtml(state.profile.nick)}" /></div>
        <div class="form-row"><label for="pf-sign">签名</label><input id="pf-sign" name="signature" type="text" maxlength="60" value="${escapeHtml(state.profile.signature)}" /></div>
        <div class="form-row"><label for="pf-loc">所在</label><input id="pf-loc" name="location" type="text" maxlength="20" value="${escapeHtml(state.profile.location)}" /></div>
        <div class="form-row"><label for="pf-ann">公告</label><textarea id="pf-ann" name="announcement" maxlength="200" style="min-height:80px">${escapeHtml(state.profile.announcement)}</textarea></div>
        <button class="btn" type="submit">保存资料</button>
      </form>`;
  return `
    <section class="composer">
      <h2 class="page-title">${editing ? "修改博文" : "写博文"}</h2>
      <form data-form="post" data-edit-id="${editing ? escapeHtml(editing.id) : ""}">
        <div class="form-row">
          <label for="post-title">标题</label>
          <input id="post-title" name="title" type="text" maxlength="40" value="${escapeHtml(editing?.title || "")}" required />
        </div>
        <div class="form-row">
          <label for="post-category">分类</label>
          <input id="post-category" name="category" type="text" maxlength="20" list="cat-list" placeholder="日记、随笔，或新分类" value="${escapeHtml(editing?.category || "")}" required />
          <datalist id="cat-list">${options}</datalist>
        </div>
        <div class="form-row">
          <label for="post-content">正文</label>
          <textarea id="post-content" name="content" maxlength="20000" required placeholder="写完就公开。空一行会分成段落。">${escapeHtml(editing?.content || "")}</textarea>
        </div>
        <button class="btn-pub" type="submit">${editing ? "保存修改" : "发表博文"}</button>
      </form>
      ${profileForm}
    </section>
  `;
}

function render() {
  applyProfile();
  const view = parseRoute().parts[0] || "home";
  const main = $("main");
  if (view === "post") main.innerHTML = renderPost();
  else if (view === "catalog") main.innerHTML = renderCatalog();
  else if (view === "about") main.innerHTML = renderAbout();
  else if (view === "board") main.innerHTML = renderBoard();
  else if (view === "write" || view === "edit") main.innerHTML = renderWrite();
  else main.innerHTML = renderList();
  window.scrollTo(0, 0);
}

function b64urlToBytes(value) {
  const padLength = value.length % 4 === 0 ? 0 : 4 - (value.length % 4);
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLength);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function jwkToAddress(jwk) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", b64urlToBytes(jwk.n)));
  return bytesToB64url(hash);
}

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "";
}

function refreshLogin() {
  const button = $("login-toggle");
  const status = $("login-status");
  $("export-wallet").disabled = state.walletMode !== "jwk";
  $("nav-write").hidden = !canWrite();
  if (!state.address) {
    button.textContent = "博主登录";
    status.textContent = "只有博主钱包可以写博文。";
    return;
  }
  const mine = canWrite();
  button.textContent = mine ? state.profile.nick : shortAddr(state.address);
  status.textContent = mine ? "已是博主，可以写、修改和删除博文。" : `已连接 ${shortAddr(state.address)}。这个钱包不能写入，页面仍只显示博主发布的内容。`;
}

async function loadArbundles() {
  const urls = ["https://esm.sh/arbundles@0.11.1", "https://cdn.jsdelivr.net/npm/arbundles@0.11.1/+esm"];
  let last;
  for (const url of urls) {
    try {
      const mod = await import(url);
      const createData = mod.createData || mod.default?.createData;
      const ArweaveSigner = mod.ArweaveSigner || mod.default?.ArweaveSigner;
      if (typeof createData === "function" && ArweaveSigner) return { createData, ArweaveSigner };
      last = new Error("签名组件不完整");
    } catch (error) {
      last = error;
    }
  }
  throw last || new Error("签名组件加载失败");
}

async function postDataItem(raw) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(UPLOAD_URL, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: raw,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`上传失败 (${response.status}) ${text.slice(0, 180)}`);
      try {
        const parsed = JSON.parse(text);
        if (parsed?.id) return parsed.id;
      } catch {
        /* plain id */
      }
      if (text.trim()) return text.trim();
      throw new Error("上传没有返回编号");
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
    }
  }
  throw last || new Error("上传失败");
}

async function uploadRecord(type, data, extraTags) {
  if (state.address !== OWNER) throw new Error("只有博主钱包可以写入。");
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  if (bytes.byteLength > MAX_BYTES) throw new Error("内容超过 100KB。");
  const tags = [
    ["App-Name", APP],
    ["App-Version", "1.0.0"],
    ["Type", type],
    ["Owner", state.address],
    ["Blog-Owner", OWNER],
    ["Unix-Time", String(data.updatedAt)],
    ["Content-Type", "application/json"],
    ...extraTags,
  ];
  setStatus("正在上传…");
  if (state.walletMode === "jwk") {
    const { createData, ArweaveSigner } = await loadArbundles();
    const signer = new ArweaveSigner(state.jwk);
    const item = createData(bytes, signer, { tags: tags.map(([name, value]) => ({ name, value: String(value).slice(0, 200) })) });
    await item.sign(signer);
    return postDataItem(item.getRaw());
  }
  if (state.walletMode === "extension" && window.arweaveWallet?.signDataItem) {
    const signed = await window.arweaveWallet.signDataItem({
      data: bytes,
      tags: tags.map(([name, value]) => ({ name, value: String(value).slice(0, 200) })),
    });
    return postDataItem(signed instanceof Uint8Array ? signed : new Uint8Array(signed));
  }
  throw new Error("请导入 wallet.json 后再上传。");
}

async function useJwk(jwk, persist) {
  if (!jwk || jwk.kty !== "RSA" || !jwk.n) throw new Error("这不是可用的 wallet.json。");
  state.walletMode = "jwk";
  state.jwk = jwk;
  state.address = await jwkToAddress(jwk);
  if (persist) localStorage.setItem(WALLET_KEY, JSON.stringify(jwk));
  refreshLogin();
  setStatus(canWrite() ? "博主钱包已就绪。" : `已连接 ${shortAddr(state.address)}。这个钱包不能写入。`, canWrite() ? "ok" : "");
  render();
}

async function connectExtension() {
  const wallet = window.arweaveWallet;
  if (!wallet) throw new Error("没有检测到 Wander 或 ArConnect。");
  await wallet.connect(["ACCESS_ADDRESS", "SIGN_TRANSACTION", "SIGNATURE"]);
  state.walletMode = "extension";
  state.jwk = null;
  state.address = await wallet.getActiveAddress();
  refreshLogin();
  setStatus(canWrite() ? "已连接博主钱包。" : `已连接 ${shortAddr(state.address)}。这个钱包不能写入。`, canWrite() ? "ok" : "");
  render();
}

function exportWallet() {
  if (!state.jwk) return;
  const blob = new Blob([JSON.stringify(state.jwk)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "wallet.json";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function publishPost(form) {
  const title = form.title.value.trim();
  const category = form.category.value.trim() || "随笔";
  const content = form.content.value.replace(/\r\n/g, "\n");
  if (!title || !content.trim()) throw new Error("标题和正文都要写。");
  const existing = form.dataset.editId ? findPost(form.dataset.editId) : null;
  const logicalId = existing?.logicalId || `post:${bytesToB64url(crypto.getRandomValues(new Uint8Array(9)))}`;
  const updatedAt = Math.floor(Date.now() / 1000);
  const createdAt = existing?.timestamp || updatedAt;
  const data = { schema: "permablog/1", type: "post", postId: logicalId, logicalId, title, category, content, createdAt, updatedAt };
  state.uploading = true;
  const id = await uploadRecord("post", data, [
    ["Title", title],
    ["Category", category],
    ["Post-Id", logicalId],
  ]);
  const post = { ...blogPost({ id, block: null, tags: [] }, data, new Map()), recordType: "post", owner: OWNER };
  state.posts = settlePosts([post, ...state.posts], []);
  rememberPending(post);
  setStatus(existing ? "修改已公开。" : "博文已公开。", "ok");
  location.hash = `#/post/${encodeURIComponent(id)}`;
}

async function deletePost(id) {
  const post = findPost(id);
  if (!post) throw new Error("没有找到这篇博文。");
  if (!canWrite()) throw new Error("只有博主钱包可以删除。");
  const ok = window.confirm(`删除《${post.title}》？读者将不再看到这篇。链上的旧记录还会留下。`);
  if (!ok) return;
  const updatedAt = Math.floor(Date.now() / 1000);
  const data = { schema: "permablog/1", type: "delete", postId: post.logicalId, updatedAt };
  state.uploading = true;
  const txId = await uploadRecord("delete", data, [["Post-Id", post.logicalId]]);
  rememberPending({ id: txId, recordType: "delete", postId: post.logicalId, timestamp: updatedAt, owner: OWNER });
  state.posts = state.posts.filter((item) => item.logicalId !== post.logicalId);
  setStatus("这篇博文已从博客移除。", "ok");
  location.hash = "#/";
}

async function publishProfile(form) {
  const data = {
    schema: "permablog/1",
    type: "profile",
    title: form.title.value.trim() || DEFAULT_PROFILE.title,
    nick: form.nick.value.trim() || DEFAULT_PROFILE.nick,
    signature: form.signature.value.trim() || DEFAULT_PROFILE.signature,
    location: form.location.value.trim() || DEFAULT_PROFILE.location,
    announcement: form.announcement.value.trim() || DEFAULT_PROFILE.announcement,
    updatedAt: Math.floor(Date.now() / 1000),
  };
  state.uploading = true;
  const id = await uploadRecord("profile", data, [["Title", data.title]]);
  state.profile = { ...state.profile, ...data };
  rememberPending({ ...data, id, recordType: "profile", timestamp: data.updatedAt, owner: OWNER });
  setStatus("资料已更新。", "ok");
  render();
}

async function publishNote(form, type) {
  const nick = form.nick.value.trim();
  const content = form.content.value.trim();
  if (!nick || !content) throw new Error("昵称和内容都要写。");
  localStorage.setItem(NICK_KEY, nick);
  const updatedAt = Math.floor(Date.now() / 1000);
  const postId = type === "comment" ? findPost(parseRoute().parts[1])?.logicalId || parseRoute().parts[1] : "";
  const data = { schema: "permablog/1", type, nick, content, postId, updatedAt };
  const tags = [["Nick", nick]];
  if (postId) tags.push(["Post-Id", postId]);
  state.uploading = true;
  const id = await uploadRecord(type, data, tags);
  const entry = { id, postId, nick, content, timestamp: updatedAt, recordType: type, owner: state.address };
  if (type === "comment") state.comments.push(entry);
  else state.guestbook.unshift(entry);
  rememberPending(entry);
  setStatus(type === "comment" ? "评论已留下。" : "留言已留下。", "ok");
  render();
}

function gotoPage(page) {
  const { parts, params } = parseRoute();
  params.set("p", String(page));
  const path = parts.length ? `/${parts.map(encodeURIComponent).join("/")}` : "/";
  location.hash = `${path}?${params.toString()}`;
}

function bind() {
  window.addEventListener("hashchange", render);
  $("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = $("search-input").value.trim();
    location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : "#/";
  });
  $("login-toggle").addEventListener("click", () => {
    $("login-panel").hidden = !$("login-panel").hidden;
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".login")) $("login-panel").hidden = true;
    const day = event.target.closest("[data-day]");
    if (day) location.hash = `#/day/${day.dataset.day}`;
    const cal = event.target.closest("[data-cal]");
    if (cal) {
      const next = new Date(state.calYear, state.calMonth + Number(cal.dataset.cal), 1);
      state.calYear = next.getFullYear();
      state.calMonth = next.getMonth();
      renderCalendar();
    }
    const pageBtn = event.target.closest("[data-page]");
    if (pageBtn && !pageBtn.disabled) gotoPage(Number(pageBtn.dataset.page));
    if (event.target.id === "retry-btn") loadBlog();
    const remove = event.target.closest("[data-delete]");
    if (remove && !state.uploading) {
      deletePost(remove.dataset.delete)
        .catch((error) => setStatus(error.message || "没有删除", "err"))
        .finally(() => {
          state.uploading = false;
        });
    }
  });
  $("main").addEventListener("submit", (event) => {
    const form = event.target.closest("form");
    if (!form) return;
    event.preventDefault();
    if (state.uploading) return;
    const kind = form.dataset.form;
    const task =
      kind === "post" ? publishPost(form) : kind === "profile" ? publishProfile(form) : kind === "comment" || kind === "guestbook" ? publishNote(form, kind) : null;
    task
      ?.catch((error) => setStatus(error.message || "没有完成", "err"))
      .finally(() => {
        state.uploading = false;
      });
  });
  $("connect-wallet").addEventListener("click", () => {
    connectExtension().catch((error) => setStatus(error.message, "err"));
  });
  $("import-wallet").addEventListener("click", () => $("wallet-file").click());
  $("wallet-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const jwk = JSON.parse(await file.text());
      await useJwk(jwk, true);
    } catch (error) {
      setStatus(error.message || "导入失败", "err");
    }
  });
  $("export-wallet").addEventListener("click", exportWallet);
}

async function boot() {
  bind();
  refreshLogin();
  render();
  const saved = localStorage.getItem(WALLET_KEY);
  if (saved) {
    try {
      await useJwk(JSON.parse(saved), false);
    } catch {
      localStorage.removeItem(WALLET_KEY);
    }
  }
  if (!state.address && window.arweaveWallet?.getActiveAddress) {
    try {
      const address = await window.arweaveWallet.getActiveAddress();
      if (address) {
        state.walletMode = "extension";
        state.address = address;
        refreshLogin();
      }
    } catch {
      /* wallet locked */
    }
  }
  await loadBlog();
}

boot().catch((error) => setStatus(error.message || "博客没有打开", "err"));
