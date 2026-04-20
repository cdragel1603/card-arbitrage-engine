'use strict';

// ── CrazyCardzCo Arbitrage Engine — Dashboard JS ─────────────────────────────

const App = (() => {
  let priceChart = null;
  let allFmvRows = [];
  let refreshCountdown = 30;
  let refreshTimer = null;

  // ── Navigation ────────────────────────────────────────────────────────────
  function initNav() {
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`section-${btn.dataset.section}`).classList.add('active');
        // Load data for section
        if (btn.dataset.section === 'portfolio') { loadPortfolio(); loadTransactions(); }
        if (btn.dataset.section === 'prices')    { loadFmv(); }
        if (btn.dataset.section === 'watchlist') { loadPlayers(); }
        if (btn.dataset.section === 'settings')  { loadSettings(); }
        if (btn.dataset.section === 'psa10')     { loadPsa10Stats(); loadPsa10Players(); loadPsa10Candidates(); }
      });
    });
  }

  // ── Stats bar ─────────────────────────────────────────────────────────────
  async function loadStats() {
    try {
      const s = await api('/api/stats');
      setText('s-active', s.activeDeals);
      setText('s-today',  s.dealsToday);
      setText('s-cards',  s.totalCards);
      setText('s-fmv',    s.totalFmvEntries);

      // ── Weekly spend stat card + header indicator ────────────────────────
      const weeklySpend = s.weeklySpend  || 0;
      const weeklyCap   = s.weeklyCap    || 1000;
      const capHit      = weeklySpend >= weeklyCap;
      const weeklyText  = `$${weeklySpend.toFixed(0)} / $${weeklyCap.toFixed(0)}`;

      const weeklyEl = document.getElementById('s-weekly-spend');
      if (weeklyEl) {
        weeklyEl.textContent = weeklyText;
        weeklyEl.className   = `value ${capHit ? 'td-red' : weeklySpend / weeklyCap >= 0.8 ? 'gold' : ''}`;
      }

      const headerIndicator = document.getElementById('weekly-spend-indicator');
      if (headerIndicator) {
        headerIndicator.textContent = `$${weeklySpend.toFixed(0)} / $${weeklyCap.toFixed(0)} this week`;
        headerIndicator.style.color = capHit ? '#f78166' : weeklySpend / weeklyCap >= 0.8 ? 'var(--gold)' : 'var(--muted)';
      }

      const banner = document.getElementById('weekly-cap-banner');
      if (banner) {
        banner.style.display = capHit ? 'flex' : 'none';
        const bannerText = document.getElementById('weekly-cap-banner-text');
        if (bannerText) bannerText.textContent = `($${weeklySpend.toFixed(0)} / $${weeklyCap.toFixed(0)})`;
      }

      // ── Per-snipe cap + auto-snipe header indicators ─────────────────────
      const snipeCapEl = document.getElementById('snipe-cap-indicator');
      if (snipeCapEl) {
        snipeCapEl.textContent = `Standard: $${(s.maxSingleSnipe || 250).toFixed(0)} | Blue Chip: $${(s.maxBlueChipSnipe || 500).toFixed(0)}`;
      }

      const autoSnipeEl = document.getElementById('auto-snipe-indicator');
      if (autoSnipeEl) {
        const on = s.autoSnipeEnabled;
        autoSnipeEl.textContent = `Auto-snipe ${on ? 'ON' : 'OFF'}`;
        autoSnipeEl.style.color = on ? 'var(--green)' : '#f78166';
      }
    } catch (e) { console.warn('Stats load failed:', e.message); }
  }

  // ── Scanner status ────────────────────────────────────────────────────────
  async function loadScannerStatus() {
    try {
      const s = await api('/api/scanner/status');
      const dot   = document.getElementById('scan-dot');
      const label = document.getElementById('scan-label');
      if (s.active) {
        dot.className = `status-dot ${s.mockMode ? 'mock' : 'active'}`;
        label.textContent = s.mockMode ? 'Mock Mode' : 'Scanning Live';
      } else {
        dot.className = 'status-dot';
        label.textContent = 'Paused';
      }
    } catch (e) { /* ignore */ }
  }

  // ── Refresh countdown ─────────────────────────────────────────────────────
  function startRefreshTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshCountdown = 30;
    refreshTimer = setInterval(() => {
      refreshCountdown--;
      const el = document.getElementById('refresh-ticker');
      if (el) el.textContent = `Refresh in ${refreshCountdown}s`;
      if (refreshCountdown <= 0) {
        refreshCountdown = 30;
        loadDeals();
        loadStats();
      }
    }, 1000);
  }

  // ── Live Deals ────────────────────────────────────────────────────────────
  async function loadDeals() {
    try {
      const deals = await api('/api/deals/live');
      const grid  = document.getElementById('deals-grid');
      const count = document.getElementById('deal-count');
      if (count) count.textContent = `${deals.length} deal${deals.length !== 1 ? 's' : ''}`;

      if (deals.length === 0) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="icon">🔍</div>
            <p>No active deals right now.</p>
            <p style="margin-top:0.4rem;font-size:0.8rem">Scanner is watching ${document.getElementById('s-fmv')?.textContent || '–'} cards across eBay, Arena Club &amp; ALT.</p>
          </div>`;
        return;
      }

      grid.innerHTML = deals.map(renderDealCard).join('');
    } catch (e) {
      console.error('loadDeals:', e);
    }
  }

  function renderConditionBadge(deal) {
    if (!deal.ai_grade) return '';
    const recClass = {
      'GRADE':    'condition-grade',
      'SELL_RAW': 'condition-sell',
      'PASS':     'condition-pass',
    }[deal.ai_recommendation] || 'condition-grade';
    const conf = deal.ai_confidence != null ? ` ${Math.round(deal.ai_confidence * 100)}%` : '';
    const title = `AI Grade: ${deal.ai_grade}${conf} confidence — ${deal.ai_recommendation}`;
    return `<span class="deal-tag ${recClass}" title="${esc(title)}">✦ ${esc(deal.ai_grade)}${conf}</span>`;
  }

  function renderDealCard(deal) {
    const isAuction = deal.listing_type === 'auction';
    const minsLeft  = deal.mins_left !== null ? Math.max(0, deal.mins_left) : null;
    const endingSoon = isAuction && minsLeft !== null && minsLeft <= 5;

    const discPct = deal.discount_pct || deal.discount_pct_calc || 0;

    // Determine tier from discount — blue chips have ≥5% threshold so deals appear at tighter margins
    const isBlueChip = discPct < 15; // heuristic for display

    return `
      <div class="deal-card" id="deal-${deal.id}">
        <span class="tier-badge ${isBlueChip ? 'blue_chip' : 'standard'}">${isBlueChip ? '🔵 Blue' : '🟢 Std'}</span>
        <div class="player-name">${esc(deal.player_name)}</div>
        <div class="card-desc">${esc(deal.card_description)}</div>
        <div class="deal-prices">
          <span class="deal-price-buy">$${fmt(deal.listing_price)}</span>
          <span class="deal-price-fmv">vs <s>$${fmt(deal.fmv)}</s> FMV</span>
        </div>
        <div class="deal-discount">${Math.round(discPct)}% under FMV</div>
        <div class="deal-meta">
          <span class="deal-tag ${isAuction ? 'auction' : 'bin'}">${isAuction ? '⏱ Auction' : '💰 BIN'}</span>
          ${deal.grade ? `<span class="deal-tag grade">${esc(deal.grade)}</span>` : ''}
          ${renderConditionBadge(deal)}
          ${isAuction && minsLeft !== null
            ? `<span class="deal-tag ${endingSoon ? 'ending-soon' : 'auction'}">${minsLeft}min left</span>`
            : ''}
          <span class="deal-tag source">${esc(deal.source || 'eBay')}</span>
        </div>
        <div class="deal-actions">
          ${deal.listing_url
            ? `<a href="${esc(deal.listing_url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">View Listing ↗</a>`
            : '<span class="btn btn-primary btn-sm" style="opacity:0.4">No URL</span>'}
          <button class="btn btn-secondary btn-sm" onclick="App.passDeal(${deal.id})">Pass</button>
        </div>
      </div>`;
  }

  async function passDeal(dealId) {
    await api(`/api/deals/${dealId}/pass`, { method: 'PATCH' });
    const card = document.getElementById(`deal-${dealId}`);
    if (card) card.style.opacity = '0.3';
    setTimeout(loadDeals, 400);
    toast('Deal passed', 'info');
  }

  async function scanNow() {
    toast('Triggering manual scan…', 'info');
    await api('/api/scanner/scan-now', { method: 'POST' });
    setTimeout(loadDeals, 3000);
  }

  // ── Watchlist / Players ───────────────────────────────────────────────────
  async function loadPlayers() {
    const grid = document.getElementById('player-grid');
    try {
      const players = await api('/api/players');
      const count   = document.getElementById('player-count');
      if (count) count.textContent = `${players.length} players`;

      if (players.length === 0) {
        grid.innerHTML = '<div class="empty-state"><p>No players yet.</p></div>';
        return;
      }

      // Group by sport
      const bySport = {};
      for (const p of players) {
        if (!bySport[p.sport]) bySport[p.sport] = [];
        bySport[p.sport].push(p);
      }

      const sportOrder = ['NFL','NBA','MLB','Soccer','NHL','Pokemon'];
      let html = '';
      for (const sport of sportOrder) {
        if (!bySport[sport]) continue;
        html += `<div style="grid-column:1/-1;font-size:0.8rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px;margin-top:0.5rem">${sport}</div>`;
        for (const p of bySport[sport]) {
          html += renderPlayerCard(p);
        }
      }
      grid.innerHTML = html;
    } catch (e) {
      grid.innerHTML = `<div class="empty-state"><p>Error loading players</p></div>`;
    }
  }

  function renderPlayerCard(p) {
    const tierColor = p.tier === 'blue_chip' ? '#79b8ff' : 'var(--green)';
    const tierLabel = p.tier === 'blue_chip' ? '🔵 Blue Chip' : '🟢 Standard';
    return `
      <div class="player-card" style="${p.active ? '' : 'opacity:0.45'}">
        <div class="player-info">
          <div class="name">${esc(p.name)}</div>
          <div class="sport">${esc(p.sport)}</div>
          <div class="tier" style="color:${tierColor};font-size:0.72rem">${tierLabel}</div>
          <div style="font-size:0.7rem;color:var(--muted);margin-top:0.1rem">${p.target_count} sets · ${p.fmv_count} FMV${p.override_count > 0 ? ` · <span style="color:var(--gold)">$${p.min_threshold_override} override</span>` : ''}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:0.35rem">
          <label class="toggle" title="${p.active ? 'Disable' : 'Enable'}">
            <input type="checkbox" ${p.active ? 'checked' : ''}
              onchange="App.togglePlayer(${p.id}, this.checked)" />
            <span class="toggle-slider"></span>
          </label>
          <button class="btn btn-danger btn-sm" onclick="App.deletePlayer(${p.id}, '${esc(p.name)}')">✕</button>
        </div>
      </div>`;
  }

  async function addPlayer() {
    const name  = document.getElementById('new-player-name').value.trim();
    const sport = document.getElementById('new-player-sport').value;
    const tier  = document.getElementById('new-player-tier').value;
    if (!name) { toast('Enter a player name', 'error'); return; }

    try {
      await api('/api/players', { method: 'POST', body: { name, sport, tier } });
      document.getElementById('new-player-name').value = '';
      toast(`Added ${name}`, 'success');
      loadPlayers();
    } catch (e) {
      toast(e.message || 'Error adding player', 'error');
    }
  }

  async function togglePlayer(id, active) {
    await api(`/api/players/${id}`, { method: 'PATCH', body: { active: active ? 1 : 0 } });
  }

  async function deletePlayer(id, name) {
    if (!confirm(`Remove ${name} from watchlist?`)) return;
    await api(`/api/players/${id}`, { method: 'DELETE' });
    toast(`Removed ${name}`, 'info');
    loadPlayers();
  }

  // ── Portfolio ─────────────────────────────────────────────────────────────
  async function loadPortfolio() {
    try {
      const s = await api('/api/portfolio/summary');
      setText('p-invested',   `$${fmt(s.totalInvested)}`);
      setText('p-value',      `$${fmt(s.currentValue)}`);
      setColoredMoney('p-unrealized', s.unrealizedPnl);
      setColoredMoney('p-realized',   s.realizedPnl);
      setColoredMoney('p-total',      s.totalPnl);
    } catch (e) { console.error('loadPortfolio:', e); }
  }

  async function loadTransactions() {
    const filter = document.getElementById('tx-filter')?.value || '';
    const url    = filter ? `/api/transactions?status=${filter}` : '/api/transactions';
    try {
      const txs   = await api(url);
      const tbody = document.getElementById('tx-tbody');
      if (txs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--muted)">No transactions yet</td></tr>';
        return;
      }
      tbody.innerHTML = txs.map(t => {
        const pnl = (t.current_value || t.fmv_at_purchase) - t.purchase_price;
        const pnlClass = pnl >= 0 ? 'td-green' : 'td-red';
        return `
          <tr>
            <td>
              <div class="td-player">${esc(t.player_name)}</div>
              <div class="td-muted" style="font-size:0.75rem">${esc(t.card_description)}</div>
            </td>
            <td>$${fmt(t.purchase_price)}</td>
            <td>$${fmt(t.fmv_at_purchase)}</td>
            <td class="td-green">${Math.round(t.discount_pct)}%</td>
            <td>$${fmt(t.current_value || t.fmv_at_purchase)}</td>
            <td class="${pnlClass}">${pnl >= 0 ? '+' : ''}$${fmt(Math.abs(pnl))}</td>
            <td><span class="badge badge-${t.status}">${t.status}</span></td>
            <td>
              <button class="btn btn-ghost btn-sm" onclick="App.editTransaction(${t.id})">Edit</button>
            </td>
          </tr>`;
      }).join('');
    } catch (e) { console.error('loadTransactions:', e); }
  }

  function editTransaction(id) {
    const val = prompt('Update current value ($):');
    if (!val) return;
    api(`/api/transactions/${id}`, {
      method: 'PATCH',
      body: { current_value: parseFloat(val) },
    }).then(() => { loadTransactions(); loadPortfolio(); toast('Updated', 'success'); });
  }

  // ── Price Intel / FMV ─────────────────────────────────────────────────────
  async function loadFmv() {
    const tbody = document.getElementById('fmv-tbody');
    try {
      allFmvRows = await api('/api/fmv');
      renderFmvTable(allFmvRows);
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--muted)">Error loading FMV data</td></tr>';
    }
  }

  function renderFmvTable(rows) {
    const tbody = document.getElementById('fmv-tbody');
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--muted)">No FMV data yet. Run a comp refresh.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => `
      <tr style="cursor:pointer" onclick="App.showPriceChart(${r.id}, '${esc(r.player_name)} ${esc(r.card_set)} ${esc(r.grade)}')">
        <td class="td-player">${esc(r.player_name)}</td>
        <td class="td-muted">${esc(r.sport)}</td>
        <td>${esc(r.card_set)}</td>
        <td><span class="badge badge-grading">${esc(r.grade)}</span></td>
        <td class="td-gold">$${fmt(r.fmv)}</td>
        <td class="td-muted">${r.sample_count}</td>
        <td><span class="badge badge-${r.trend}">${trendArrow(r.trend)} ${r.trend}</span></td>
        <td class="td-muted">${timeAgo(r.last_updated)}</td>
      </tr>`
    ).join('');
  }

  function filterFmv(query) {
    if (!query) { renderFmvTable(allFmvRows); return; }
    const q = query.toLowerCase();
    renderFmvTable(allFmvRows.filter(r =>
      r.player_name.toLowerCase().includes(q) ||
      r.card_set.toLowerCase().includes(q) ||
      r.grade.toLowerCase().includes(q)
    ));
  }

  async function showPriceChart(fmvId, title) {
    const panel = document.getElementById('chart-panel');
    const titleEl = document.getElementById('chart-title');
    panel.style.display = 'block';
    titleEl.textContent = title;
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const history = await api(`/api/fmv/${fmvId}/history?days=30`);
      renderChart(history, title);
    } catch (e) {
      toast('No price history available yet', 'info');
    }
  }

  function renderChart(history, title) {
    const ctx = document.getElementById('price-chart').getContext('2d');
    if (priceChart) priceChart.destroy();

    const labels = history.map(h => new Date(h.sale_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    const data   = history.map(h => h.price);

    priceChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Sale Price',
          data,
          borderColor: '#4a9e3f',
          backgroundColor: 'rgba(74,158,63,0.1)',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '#4a9e3f',
          tension: 0.3,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#161b22',
            borderColor: '#30363d',
            borderWidth: 1,
            titleColor: '#f5f0e1',
            bodyColor: '#8b949e',
            callbacks: {
              label: ctx => `$${ctx.parsed.y.toFixed(2)}`,
            },
          },
        },
        scales: {
          x: { ticks: { color: '#8b949e', maxTicksLimit: 8 }, grid: { color: '#21262d' } },
          y: {
            ticks: { color: '#8b949e', callback: v => `$${v}` },
            grid: { color: '#21262d' },
          },
        },
      },
    });
  }

  async function refreshComps() {
    toast('Comp refresh triggered — may take a few minutes', 'info');
    await api('/api/scanner/refresh-comps', { method: 'POST' });
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  async function loadSettings() {
    try {
      const s = await api('/api/settings');
      setValue('s-blue-chip', Math.round(parseFloat(s.blue_chip_threshold || 0.95) * 100));
      setValue('s-standard',  Math.round(parseFloat(s.standard_threshold  || 0.80) * 100));
      setValue('s-min-price', s.min_card_price || 100);
      setValue('s-max-card',  s.max_spend_per_card || 2500);
      setValue('s-weekly-cap', s.weekly_spend_cap  || 1000);
      setValue('s-max-snipe',      s.max_single_snipe_usd    || 250);
      setValue('s-max-blue-snipe', s.max_blue_chip_snipe_usd || 500);
      setValue('s-min-comps',  s.min_comp_samples   || 5);
      setValue('s-fvf-pct',    Math.round(parseFloat(s.ebay_fvf_pct || 0.13) * 100));
      setValue('s-shipping',   s.shipping_cost_usd  || 5);
      setChecked('t-sms',        s.sms_enabled !== 'false');
      setChecked('t-auto-snipe', s.auto_snipe_enabled === 'true');
      setChecked('t-snipe',      s.auto_snipe_auctions !== 'false');
      setChecked('t-scan',       s.scan_active !== 'false');
    } catch (e) { toast('Error loading settings', 'error'); }
  }

  async function saveSettings() {
    const settings = {
      blue_chip_threshold: (parseFloat(document.getElementById('s-blue-chip').value) / 100).toString(),
      standard_threshold:  (parseFloat(document.getElementById('s-standard').value) / 100).toString(),
      min_card_price:      document.getElementById('s-min-price').value,
      max_spend_per_card:  document.getElementById('s-max-card').value,
      weekly_spend_cap:    document.getElementById('s-weekly-cap').value,
      max_single_snipe_usd:     document.getElementById('s-max-snipe').value,
      max_blue_chip_snipe_usd:  document.getElementById('s-max-blue-snipe').value,
      min_comp_samples:    document.getElementById('s-min-comps').value,
      ebay_fvf_pct:        (parseFloat(document.getElementById('s-fvf-pct').value) / 100).toString(),
      shipping_cost_usd:   document.getElementById('s-shipping').value,
    };
    await api('/api/settings', { method: 'PATCH', body: settings });
    toast('Settings saved', 'success');
  }

  async function saveSetting(key, value) {
    await api('/api/settings', { method: 'PATCH', body: { [key]: String(value) } });
  }

  async function sendTestSms() {
    const result = await api('/api/alerts/test-sms', { method: 'POST' });
    toast(result.sent ? 'Test SMS sent!' : `SMS not sent: ${result.reason}`, result.sent ? 'success' : 'error');
  }

  async function changePassword() {
    const cur = document.getElementById('cur-pass').value;
    const nw  = document.getElementById('new-pass').value;
    if (!cur || !nw) { toast('Fill in both fields', 'error'); return; }
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
      document.getElementById('cur-pass').value = '';
      document.getElementById('new-pass').value = '';
      toast('Password updated', 'success');
    } catch (e) { toast(e.message || 'Error updating password', 'error'); }
  }

  // ── PSA 10 Hunter ─────────────────────────────────────────────────────────
  async function loadPsa10Stats() {
    try {
      const s = await api('/api/psa10/stats');
      setText('p10-active',  s.activeCount);
      setText('p10-psa10',   s.psa10Count);
      setText('p10-psa9',    s.psa9Count);
      setText('p10-today',   s.todayScanned);
      setText('p10-targets', s.targets);
    } catch (e) { console.warn('PSA10 stats load failed:', e.message); }
  }

  async function loadPsa10Players() {
    try {
      const players = await api('/api/psa10/players');
      const sel = document.getElementById('p10-filter-player');
      if (!sel) return;
      const currentVal = sel.value;
      // Preserve existing "All Players" option
      const extras = players.map(p =>
        `<option value="${esc(p.name)}">${esc(p.name)} (${esc(p.sport)})</option>`
      ).join('');
      sel.innerHTML = `<option value="">All Players</option>${extras}`;
      if (currentVal) sel.value = currentVal;
    } catch (e) { /* ignore */ }
  }

  async function loadPsa10Candidates() {
    const grid    = document.getElementById('psa10-grid');
    const sport   = document.getElementById('p10-filter-sport')?.value  || '';
    const player  = document.getElementById('p10-filter-player')?.value || '';
    const gradeEl = document.getElementById('p10-filter-grade');
    const gradeFilter = gradeEl ? gradeEl.value : '';

    try {
      let url = '/api/psa10/candidates?limit=100';
      if (sport)  url += `&sport=${encodeURIComponent(sport)}`;
      if (player) url += `&player=${encodeURIComponent(player)}`;

      let candidates = await api(url);

      // Client-side grade filter (API returns all grades; filter by num)
      if (gradeFilter) {
        const gradeNum = parseInt(gradeFilter, 10);
        candidates = candidates.filter(c => c.ai_grade_num === gradeNum);
      }

      if (candidates.length === 0) {
        grid.innerHTML = `
          <div class="empty-state" style="grid-column:1/-1">
            <div class="icon">🎯</div>
            <p>No candidates match the current filter.</p>
            <p style="margin-top:0.4rem;font-size:0.8rem">Hunter scans raw listings every 15 min and grades with GPT-4o Vision.</p>
          </div>`;
        return;
      }

      grid.innerHTML = candidates.map(renderPsa10Card).join('');
    } catch (e) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>Error loading candidates</p></div>`;
      console.error('loadPsa10Candidates:', e);
    }
  }

  function renderPsa10Card(c) {
    const gradeNum = c.ai_grade_num;
    const conf     = c.ai_confidence != null ? Math.round(c.ai_confidence * 100) : null;
    const details  = c.ai_details ? (() => { try { return JSON.parse(c.ai_details); } catch { return {}; } })() : {};

    const gradeColor = gradeNum >= 10 ? 'var(--gold)' : gradeNum >= 9 ? 'var(--green)' : 'var(--cream)';
    const gradeLabel = c.ai_grade || 'Ungraded';

    // ── Sub-grades row ─────────────────────────────────────────────────────
    const subGradeParts = [
      details.centering != null ? `Ctr ${details.centering}` : null,
      details.corners   != null ? `Cor ${details.corners}`   : null,
      details.edges     != null ? `Edg ${details.edges}`     : null,
      details.surface   != null ? `Srf ${details.surface}`   : null,
    ].filter(Boolean);
    const subGradesHtml = subGradeParts.length
      ? `<div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-top:0.3rem">
           ${subGradeParts.map(s => {
             const val = parseFloat(s.split(' ')[1]);
             const col = val >= 9.5 ? 'var(--gold)' : val >= 9 ? 'var(--green)' : val >= 8 ? 'var(--cream)' : '#f78166';
             return `<span style="font-size:0.68rem;font-family:monospace;color:${col};background:rgba(255,255,255,0.05);padding:0.1rem 0.3rem;border-radius:3px">${esc(s)}</span>`;
           }).join('')}
         </div>`
      : '';

    // ── Pricing intelligence panel ─────────────────────────────────────────
    const price    = c.listing_price;
    const rawFmv   = c.raw_fmv;
    const psa10Fmv = c.psa10_fmv;

    // Spread: what you'd gain by buying and grading (net of ~$50 grading + shipping)
    const GRADING_COST = 50;
    const spreadNet  = psa10Fmv ? psa10Fmv - price - GRADING_COST : null;
    const spreadPct  = spreadNet != null && price > 0 ? Math.round(spreadNet / price * 100) : null;
    const spreadPos  = spreadNet != null && spreadNet > 0;

    const pricingRows = [];
    pricingRows.push(
      `<div style="display:flex;justify-content:space-between;align-items:center">
         <span style="color:var(--muted);font-size:0.75rem">List price</span>
         <span style="font-weight:700;font-size:0.9rem">$${fmt(price)}</span>
       </div>`
    );
    if (rawFmv) {
      const rawDiff = rawFmv - price;
      const rawPos  = rawDiff >= 0;
      pricingRows.push(
        `<div style="display:flex;justify-content:space-between;align-items:center">
           <span style="color:var(--muted);font-size:0.75rem">Raw FMV</span>
           <span style="font-size:0.8rem">$${fmt(rawFmv)}
             <span style="font-size:0.7rem;color:${rawPos ? 'var(--green)' : '#f78166'};margin-left:0.25rem">${rawPos ? '+' : ''}$${fmt(Math.abs(rawDiff))}</span>
           </span>
         </div>`
      );
    }
    if (psa10Fmv) {
      pricingRows.push(
        `<div style="display:flex;justify-content:space-between;align-items:center">
           <span style="color:var(--muted);font-size:0.75rem">PSA 10 FMV</span>
           <span style="font-size:0.8rem;color:var(--gold)">$${fmt(psa10Fmv)}</span>
         </div>`
      );
    }
    if (spreadNet != null) {
      pricingRows.push(
        `<div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,0.08);margin-top:0.3rem;padding-top:0.3rem">
           <span style="color:var(--muted);font-size:0.72rem">Net after grading (~$${GRADING_COST})</span>
           <span style="font-weight:700;font-size:0.82rem;color:${spreadPos ? 'var(--green)' : '#f78166'}">${spreadPos ? '+' : ''}$${fmt(spreadNet)} ${spreadPct != null ? `(${spreadPct}%)` : ''}</span>
         </div>`
      );
    }

    const pricingHtml = `
      <div style="margin:0.6rem 0;padding:0.5rem;background:rgba(255,255,255,0.03);border-radius:6px;border:1px solid rgba(255,255,255,0.07);display:flex;flex-direction:column;gap:0.25rem">
        ${pricingRows.join('')}
      </div>`;

    // ── Confidence bar ─────────────────────────────────────────────────────
    const confBarColor = conf >= 80 ? 'var(--gold)' : conf >= 65 ? 'var(--green)' : 'var(--muted)';
    const confHtml = conf != null
      ? `<div style="margin-bottom:0.5rem">
           <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.2rem">
             <span style="font-size:0.72rem;color:var(--muted)">PSA 10 confidence</span>
             <span style="font-size:0.8rem;font-weight:700;color:${confBarColor}">${conf}%</span>
           </div>
           <div style="height:4px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden">
             <div style="height:100%;width:${conf}%;background:${confBarColor};border-radius:2px;transition:width 0.3s"></div>
           </div>
         </div>`
      : '';

    const notesHtml = c.ai_notes
      ? `<div style="font-size:0.7rem;color:var(--muted);margin-top:0.3rem;font-style:italic;line-height:1.4">${esc(c.ai_notes.slice(0, 120))}</div>`
      : '';

    const imgHtml = c.image_url
      ? `<div style="text-align:center;margin-bottom:0.75rem">
           <img src="${esc(c.image_url)}" alt="${esc(c.player_name)}" loading="lazy"
             style="max-height:160px;max-width:100%;border-radius:6px;object-fit:contain;background:#1a1a2e" />
         </div>`
      : '';

    const alertBadge = c.alert_sent
      ? `<span class="deal-tag condition-grade" title="SMS alert sent">📲 Alerted</span>`
      : '';

    return `
      <div class="deal-card" id="psa10-${c.id}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem">
          <span class="tier-badge blue_chip">${esc(c.sport)}</span>
          ${alertBadge}
        </div>
        ${imgHtml}
        <div class="player-name">${esc(c.player_name)}</div>
        <div class="card-desc" style="margin-bottom:0.6rem">${esc(c.card_description)}</div>

        <!-- AI Grade badge + confidence bar -->
        <div style="padding:0.5rem;background:rgba(255,255,255,0.04);border-radius:6px;border:1px solid rgba(255,255,255,0.08);margin-bottom:0.5rem">
          <div style="font-size:0.88rem;font-weight:700;color:${gradeColor};margin-bottom:0.35rem">${esc(gradeLabel)}</div>
          ${confHtml}
          ${subGradesHtml}
          ${notesHtml}
        </div>

        <!-- Pricing intelligence: list price / raw FMV / PSA 10 FMV / spread -->
        ${pricingHtml}

        <div class="deal-meta" style="margin-top:0.5rem">
          <span class="deal-tag bin">💰 BIN/BO</span>
          <span class="deal-tag source">eBay</span>
        </div>
        <div class="deal-actions" style="margin-top:0.75rem">
          ${c.listing_url
            ? `<a href="${esc(c.listing_url)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">View on eBay ↗</a>`
            : '<span class="btn btn-primary btn-sm" style="opacity:0.4">No URL</span>'}
          <button class="btn btn-secondary btn-sm" onclick="App.passPsa10(${c.id})">Pass</button>
        </div>
        <div style="font-size:0.68rem;color:var(--muted);margin-top:0.4rem;text-align:right">${timeAgo(c.scanned_at)}</div>
      </div>`;
  }

  async function passPsa10(candidateId) {
    await api(`/api/psa10/candidates/${candidateId}/pass`, { method: 'PATCH' });
    const card = document.getElementById(`psa10-${candidateId}`);
    if (card) card.style.opacity = '0.3';
    setTimeout(loadPsa10Candidates, 400);
    toast('Candidate passed', 'info');
  }

  async function psa10ScanNow() {
    toast('PSA 10 Hunter scan triggered…', 'info');
    await api('/api/psa10/scan-now', { method: 'POST' });
    setTimeout(() => { loadPsa10Candidates(); loadPsa10Stats(); }, 5000);
  }

  // ── API helper ────────────────────────────────────────────────────────────
  async function api(url, opts = {}) {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    if (res.status === 401) { window.location.href = '/auth/login'; return; }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── Utility ───────────────────────────────────────────────────────────────
  function fmt(n) {
    if (n == null) return '–';
    return Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val ?? '–';
  }

  function setValue(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
  }

  function setChecked(id, checked) {
    const el = document.getElementById(id);
    if (el) el.checked = !!checked;
  }

  function setColoredMoney(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    const isPos = val >= 0;
    el.className = `value ${isPos ? 'pnl-positive' : 'pnl-negative'}`;
    el.textContent = `${isPos ? '+' : '-'}$${fmt(Math.abs(val))}`;
  }

  function trendArrow(trend) {
    return trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→';
  }

  function timeAgo(isoStr) {
    if (!isoStr) return '–';
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  // ── Toast notifications ───────────────────────────────────────────────────
  function toast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${esc(msg)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, 3500);
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    initNav();
    loadStats();
    loadDeals();
    loadScannerStatus();
    startRefreshTimer();

    // Auto-refresh deals every 30s
    setInterval(() => {
      loadDeals();
      loadStats();
      loadScannerStatus();
    }, 30000);
  }

  // Public surface
  return {
    init,
    loadDeals,
    loadPlayers,
    loadPortfolio,
    loadTransactions,
    loadFmv,
    loadSettings,
    addPlayer,
    togglePlayer,
    deletePlayer,
    passDeal,
    scanNow,
    saveSettings,
    saveSetting,
    sendTestSms,
    changePassword,
    filterFmv,
    showPriceChart,
    refreshComps,
    editTransaction,
    loadPsa10Candidates,
    passPsa10,
    psa10ScanNow,
    toast,
  };
})();

document.addEventListener('DOMContentLoaded', App.init);
