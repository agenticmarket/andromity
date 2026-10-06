export function getUsageScript(): string {
  return String.raw`
    let usageModelPage = 0;
    let usageProviderPage = 0;
    let usageSessionPage = 0;
    let usagePending = false;
    let usageRequestId = 0;
    let usageShareImage = '';
    let usageShareCaption = '';
    const usagePageSize = 10;
    const usageColors = ['#1b2833', '#174c36', '#217a46', '#32b45b', '#6ee787'];

    function usageDays(range, now = new Date()) {
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const count = range === 'today' ? 1 : range === 'week' ? 7 : range === 'month' ? 30 : 365;
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - count + 1);
      const days = [];
      for (let i = 0; i < count; i++) {
        const date = new Date(start);
        date.setUTCDate(date.getUTCDate() + i);
        const key = date.toISOString().slice(0, 10);
        const data = (usageData.daily_activity || {})[key] || {};
        days.push({ key, date, tokens: Number(data.tokens) || 0, count: Number(data.count) || 0, cost: Number(data.cost) || 0 });
      }
      return days;
    }

    function usageActivityStats(days) {
      let best = 0, streak = 0, active = 0;
      days.forEach(day => {
        if (day.tokens > 0) { active++; streak++; best = Math.max(best, streak); }
        else streak = 0;
      });
      // An unfinished UTC day should not end yesterday's streak.
      let index = days.length - 1;
      if (index >= 0 && days[index].tokens === 0) index--;
      let current = 0;
      while (index >= 0 && days[index--].tokens > 0) current++;
      return { active, best, current };
    }

    function usageLevel(tokens, max) {
      return tokens <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(Math.sqrt(tokens / Math.max(1, max)) * 4)));
    }

    function usageBarSlots(sessions, range, now = new Date()) {
      if (range !== 'today') {
        return usageDays(range === 'week' ? 'week' : 'month', now).slice(range === 'week' ? -7 : -14).map(day => ({
          ...day, label: (day.date.getUTCMonth() + 1) + '/' + day.date.getUTCDate(),
          fullDate: day.key + ' (UTC)',
        }));
      }
      const key = now.toISOString().slice(0, 10);
      const slots = Array.from({length: 12}, (_, index) => ({ tokens: 0, cost: 0, count: 0,
        label: String(index * 2).padStart(2, '0') + ':00', fullDate: 'Today ' + String(index * 2).padStart(2, '0') + ':00 (UTC)' }));
      const hours = usageData.hourly_activity;
      if (hours) {
        Object.entries(hours).forEach(([stamp, data]) => {
          if (stamp.slice(0, 10) !== key) return;
          const index = Math.floor(Number(stamp.slice(11, 13)) / 2);
          if (!slots[index]) return;
          slots[index].tokens += Number(data.tokens) || 0;
          slots[index].cost += Number(data.cost) || 0;
          slots[index].count += Number(data.count) || 0;
        });
      } else {
        sessions.forEach(session => {
          const date = new Date(session.updated_at || session.created_at || 0);
          if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== key) return;
          const slot = slots[Math.floor(date.getUTCHours() / 2)];
          slot.tokens += Number(session.token_total || session.tokens) || 0;
          slot.cost += Number(session.cost_usd) || 0;
          slot.count++;
        });
      }
      return slots;
    }

    function usageGridSvg(days, width = 900, textColor = 'var(--text-muted)') {
      const offset = days[0].date.getUTCDay();
      const weeks = Math.ceil((offset + days.length) / 7);
      const step = Math.min(30, (width - 54) / weeks);
      const size = step - Math.max(2, step * .18);
      const height = 42 + step * 7 + 32;
      const max = Math.max(1, ...days.map(day => day.tokens));
      let content = '';
      let lastMonth = -1;
      days.forEach((day, index) => {
        const column = Math.floor((offset + index) / 7);
        const row = (offset + index) % 7;
        if ((index === 0 || row === 0) && day.date.getUTCMonth() !== lastMonth) {
          const label = day.date.toLocaleDateString('en', { month: 'short', timeZone: 'UTC' });
          content += '<text x="' + (50 + column * step) + '" y="22" fill="' + textColor + '" font-size="12">' + label + '</text>';
          lastMonth = day.date.getUTCMonth();
        }
        const title = day.key + ': ' + day.tokens.toLocaleString() + ' tokens · ' + day.count + ' sessions (UTC)';
        content += '<rect class="usage-day" tabindex="0" role="img" aria-label="' + title + '" x="' + (50 + column * step) + '" y="' + (36 + row * step) + '" width="' + size + '" height="' + size + '" rx="2" fill="' + usageColors[usageLevel(day.tokens, max)] + '"><title>' + title + '</title></rect>';
      });
      [1, 3, 5].forEach(row => {
        content += '<text x="0" y="' + (36 + row * step + size * .8) + '" fill="' + textColor + '" font-size="11">' + ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][row] + '</text>';
      });
      content += '<text x="' + (width - 164) + '" y="' + (height - 6) + '" fill="' + textColor + '" font-size="11">Less</text>';
      usageColors.forEach((color, index) => {
        content += '<rect x="' + (width - 132 + index * 16) + '" y="' + (height - 17) + '" width="12" height="12" rx="2" fill="' + color + '"/>';
      });
      content += '<text x="' + (width - 45) + '" y="' + (height - 6) + '" fill="' + textColor + '" font-size="11">More</text>';
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + width + ' ' + height + '" style="width:100%;min-width:520px" aria-label="Daily session token activity" role="img">' + content + '</svg>';
    }

    function usagePagination(id, page, total, size) {
      const container = document.getElementById(id);
      if (!container) return;
      const pages = Math.max(1, Math.ceil(total / size));
      container.innerHTML = '<span>' + (total ? (page * size + 1) + '–' + Math.min(total, (page + 1) * size) : '0') + ' of ' + total.toLocaleString() + '</span>' +
        '<div><button class="btn btn-secondary" data-usage-page="' + id + '" data-page="' + (page - 1) + '" ' + (page === 0 || usagePending ? 'disabled' : '') + '>Previous</button> ' +
        '<span> ' + (page + 1) + ' / ' + pages + ' </span> ' +
        '<button class="btn btn-secondary" data-usage-page="' + id + '" data-page="' + (page + 1) + '" ' + (page + 1 >= pages || usagePending ? 'disabled' : '') + '>Next</button></div>';
    }

    function requestUsage(reset = true) {
      if (reset) usageModelPage = usageProviderPage = usageSessionPage = 0;
      usagePending = true;
      usageRequestId++;
      document.getElementById('usage-status').textContent = 'Loading usage…';
      document.getElementById('usage-share-open').disabled = true;
      usagePagination('usage-sessions-pagination', usageSessionPage, usageData.sessions_total ?? usageData.total_sessions ?? 0, usagePageSize);
      vscode.postMessage({ type: 'fetch_usage', timeRange: currentUsageRange, scope: currentUsageScope, offset: usageSessionPage * usagePageSize, limit: usagePageSize, requestId: usageRequestId });
    }

    function renderUsage() {
      if (usagePending) return;
      const sessions = usageData.sessions || [];
      const tokens = usageData.total_tokens ?? 0;
      const total = usageData.total_sessions ?? 0;
      document.getElementById('stat-usage-tokens').textContent = formatTokens(tokens);
      document.getElementById('stat-usage-cost').textContent = '$' + Number(usageData.total_cost_usd || 0).toFixed(4);
      document.getElementById('stat-usage-sessions').textContent = total.toLocaleString();
      document.getElementById('stat-usage-avg').textContent = formatTokens(total ? Math.round(tokens / total) : 0);
      const days = usageDays(currentUsageRange);
      const stats = usageActivityStats(days);
      document.getElementById('usage-activity-summary').textContent = stats.active + ' active days · ' + stats.current + ' day current streak · ' + stats.best + ' day best streak';
      document.getElementById('usage-activity-period').textContent = days[0].key + ' – ' + days[days.length - 1].key + ' · UTC';
      document.getElementById('usage-chart-container').innerHTML = usageGridSvg(days);
      renderUsageChart(sessions, currentUsageRange);
      renderModelBreakdown(sessions);
      renderProviderBreakdown(sessions);
      renderSessionsTable(sessions);
      const serverPaged = typeof usageData.sessions_offset === 'number';
      const count = serverPaged ? usageData.sessions_total : sessions.length;
      usagePagination('usage-sessions-pagination', usageSessionPage, count || 0, usagePageSize);
      document.getElementById('usage-status').textContent = usagePending ? 'Loading usage…' : '';
      document.getElementById('usage-share-open').disabled = usagePending;
    }

    function usageShareCanvas() {
      const format = document.getElementById('usage-share-format').value;
      const kind = document.getElementById('usage-share-kind').value;
      const showCost = document.getElementById('usage-share-cost').checked;
      const dimensions = format === 'story' ? [1080, 1920] : format === 'landscape' ? [1200, 675] : [1080, 1080];
      const canvas = document.createElement('canvas');
      [canvas.width, canvas.height] = dimensions;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      const w = canvas.width, h = canvas.height;
      const story = format === 'story', landscape = format === 'landscape';
      const pad = 64, top = story ? 260 : 56;
      const gradient = ctx.createLinearGradient(0, 0, w, h);
      gradient.addColorStop(0, '#0b1421'); gradient.addColorStop(1, '#142f28');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
      const text = (value, x, y, size, color = '#f1f7f4', weight = '600') => {
        ctx.fillStyle = color; ctx.font = weight + ' ' + size + 'px Arial, Helvetica, sans-serif'; ctx.fillText(value, x, y, w - x - pad);
      };
      const line = (y) => { ctx.fillStyle = '#294339'; ctx.fillRect(pad, y, w - pad * 2, 1); };
      const logo = document.getElementById('usage-brand-logo');
      if (!logo.complete || !logo.naturalWidth) throw new Error('Logo unavailable');
      ctx.drawImage(logo, pad, top - 38, 54, 54);
      text('ANDROMITY', pad + 70, top, 25, '#6ee787', '700');
      text(kind === 'activity' ? 'Showing up. Building more.' : kind === 'daily' ? 'A little progress, every day.' : 'My coding, by the numbers.', pad, top + 74, landscape ? 42 : 48, '#f1f7f4', '700');
      const range = { all: 'All time', month: 'Last 30 days', week: 'Last 7 days', today: 'Last 24 hours' }[currentUsageRange];
      text(range + ' · ' + (currentUsageScope === 'project' ? 'One project' : 'All projects') + ' · ' + new Date().toISOString().slice(0, 10), pad, top + 113, 20, '#a2bbb0', '400');
      const days = usageDays(currentUsageRange);
      const stats = usageActivityStats(days);
      const activityLabel = currentUsageRange === 'all' ? 'ACTIVE DAYS · LAST YEAR' : 'ACTIVE DAYS · GRID';
      const metrics = kind === 'activity'
        ? [[String(stats.active), activityLabel], [String(stats.best) + ' days', 'BEST STREAK · GRID'], [formatTokens(days.reduce((sum, day) => sum + day.tokens, 0)), 'TOKENS IN GRID']]
        : [[formatTokens(usageData.total_tokens || 0), 'TOKENS'], [Number(usageData.total_sessions || 0).toLocaleString(), 'SESSIONS'], [String(stats.active), activityLabel]];
      const metricY = top + (landscape ? 204 : story ? 320 : 240);
      const metricWidth = (w - 2 * pad) / 3;
      metrics.forEach(([value, label], index) => {
        text(value, pad + index * metricWidth, metricY, landscape ? 40 : 48, '#6ee787', '700');
        text(label, pad + index * metricWidth, metricY + 34, 16, '#a2bbb0');
      });
      const gridTop = metricY + (landscape ? 65 : story ? 190 : 110);
      line(gridTop - 24);
      text(kind === 'daily' ? 'DAILY TOKEN ACTIVITY' : 'DAILY SESSION ACTIVITY', pad, gridTop + 6, 16, '#a2bbb0');
      const gridWidth = w - 2 * pad;
      const offset = days[0].date.getUTCDay();
      const weeks = Math.ceil((offset + days.length) / 7);
      const step = Math.min(landscape ? 19 : 25, gridWidth / weeks);
      const size = step - Math.max(2, step * .18);
      const max = Math.max(1, ...days.map(day => day.tokens));
      let lastMonth = -1;
      if (kind !== 'daily') days.forEach((day, index) => {
        const col = Math.floor((offset + index) / 7), row = (offset + index) % 7;
        if ((index === 0 || row === 0) && day.date.getUTCMonth() !== lastMonth) {
          text(day.date.toLocaleDateString('en', { month: 'short', timeZone: 'UTC' }), pad + col * step, gridTop + 35, 13, '#a2bbb0', '400');
          lastMonth = day.date.getUTCMonth();
        }
        ctx.fillStyle = usageColors[usageLevel(day.tokens, max)];
        ctx.fillRect(pad + col * step, gridTop + 50 + row * step, size, size);
      });
      let afterGrid = gridTop + 50 + step * 7;
      let periodText = days[0].key + ' – ' + days[days.length - 1].key + ' (UTC)';
      if (kind === 'daily') {
        const slots = usageBarSlots(usageData.sessions || [], currentUsageRange);
        const maxTokens = Math.max(1, ...slots.map(slot => slot.tokens));
        const chartHeight = landscape ? 85 : 180;
        const chartTop = gridTop + 32;
        const colWidth = gridWidth / slots.length;
        [0, .5, 1].forEach(ratio => {
          const y = chartTop + chartHeight * (1 - ratio);
          ctx.fillStyle = '#294339'; ctx.fillRect(pad, y, gridWidth, 1);
        });
        slots.forEach((slot, index) => {
          const barHeight = slot.tokens > 0 ? Math.max(4, chartHeight * slot.tokens / maxTokens) : 2;
          ctx.fillStyle = slot.tokens > 0 ? '#45c66b' : '#294339';
          ctx.fillRect(pad + index * colWidth + colWidth * .2, chartTop + chartHeight - barHeight, colWidth * .6, barHeight);
          text(slot.label, pad + index * colWidth + 2, chartTop + chartHeight + 22, 12, '#a2bbb0', '400');
        });
        text('Peak · ' + formatTokens(maxTokens === 1 && !slots.some(slot => slot.tokens) ? 0 : maxTokens) + ' tokens', pad, chartTop + chartHeight + 52, 16, '#a2bbb0');
        afterGrid = chartTop + chartHeight + 54;
        periodText = currentUsageRange === 'today' ? 'Today · 2-hour intervals (UTC)' : currentUsageRange === 'week' ? 'Last 7 days (UTC)' : 'Last 14 days (UTC)';
      }
      text(periodText, pad, afterGrid + 28, 16, '#a2bbb0', '400');
      text('Session totals grouped by last activity date.', pad, afterGrid + 54, 14, '#8ea99c', '400');
      if (showCost) text('Estimated API cost · $' + Number(usageData.total_cost_usd || 0).toFixed(4), pad, afterGrid + (landscape ? 76 : 98), landscape ? 16 : 20);
      if (!landscape) {
        const streakY = story ? 1300 : 860;
        text(String(stats.current), pad, streakY, story ? 112 : 80, '#6ee787', '700');
        text('DAY CURRENT STREAK', pad, streakY + 38, 18, '#a2bbb0');
        text('Keep showing up. Keep building.', pad, streakY + 80, 25, '#cce7d6');
      }
      const footer = story ? h - 245 : h - 62;
      line(footer - 35);
      text('Build your next idea with Andromity.', pad, footer, 21);
      text('github.com/agenticmarket/andromity', pad, footer + 30, 17, '#6ee787', '500');
      return { canvas, stats, range };
    }

    async function updateUsageSharePreview() {
      try {
        const logo = document.getElementById('usage-brand-logo');
        if (!logo.complete) await logo.decode();
        const { canvas, stats, range } = usageShareCanvas();
        usageShareImage = canvas.toDataURL('image/png');
        document.getElementById('usage-share-preview').src = usageShareImage;
        const gridPeriod = currentUsageRange === 'all' ? 'past year' : 'activity grid';
        usageShareCaption = 'Building with Andromity: ' + formatTokens(usageData.total_tokens || 0) + ' tokens · ' + Number(usageData.total_sessions || 0).toLocaleString() + ' sessions. ' + range + '. ' + stats.active + ' active days in my ' + gridPeriod + '. Session totals grouped by last activity date.\nhttps://github.com/agenticmarket/andromity #Andromity #BuildInPublic';
        document.getElementById('usage-share-status').textContent = '';
        document.getElementById('usage-share-save').disabled = false;
      } catch (error) {
        usageShareImage = '';
        document.getElementById('usage-share-save').disabled = true;
        document.getElementById('usage-share-status').textContent = 'Could not create the image. Close the preview and try again.';
      }
    }

    document.getElementById('pane-usage').addEventListener('click', event => {
      const share = event.target.closest('[data-usage-share-kind]');
      if (share && !usagePending) {
        document.getElementById('usage-share-kind').value = share.dataset.usageShareKind;
        updateUsageSharePreview();
        document.getElementById('usage-share-dialog').showModal();
        return;
      }
      const button = event.target.closest('[data-usage-page]');
      if (!button || button.disabled || usagePending) return;
      const page = Math.max(0, Number(button.dataset.page) || 0);
      if (button.dataset.usagePage === 'usage-models-pagination') { usageModelPage = page; renderModelBreakdown(usageData.sessions || []); }
      else if (button.dataset.usagePage === 'usage-providers-pagination') { usageProviderPage = page; renderProviderBreakdown(usageData.sessions || []); }
      else {
        usageSessionPage = page;
        if (typeof usageData.sessions_offset === 'number') requestUsage(false);
        else renderUsage();
      }
    });
    document.getElementById('usage-share-open').addEventListener('click', () => {
      if (usagePending) return;
      updateUsageSharePreview();
      document.getElementById('usage-share-dialog').showModal();
    });
    document.getElementById('usage-share-close').addEventListener('click', () => document.getElementById('usage-share-dialog').close());
    ['usage-share-kind', 'usage-share-format', 'usage-share-cost'].forEach(id => document.getElementById(id).addEventListener('change', updateUsageSharePreview));
    document.getElementById('usage-share-save').addEventListener('click', () => {
      if (!usageShareImage) return;
      document.getElementById('usage-share-save').disabled = true;
      document.getElementById('usage-share-status').textContent = 'Choose where to save your PNG…';
      vscode.postMessage({ type: 'export_usage_image', image: usageShareImage, format: document.getElementById('usage-share-format').value, kind: document.getElementById('usage-share-kind').value });
    });
    document.getElementById('usage-share-caption').addEventListener('click', () => vscode.postMessage({ type: 'copy_usage_caption', caption: usageShareCaption }));
  `;
}
