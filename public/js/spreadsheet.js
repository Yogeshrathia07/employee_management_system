/* ═══════════════════════════════════════════════════════════
   Payroll Manager — 3 tabs: Database | Consolidation | Salary Slip
   ═══════════════════════════════════════════════════════════ */

const DEFAULT_ROWS = 25;

// ─── Number to Words (Indian system) ────────────────────────────────────────
function numberToWords(n) {
  const num = Math.round(Math.abs(n || 0));
  if (num === 0) return 'Zero Only';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function conv(x) {
    if (x === 0) return '';
    if (x < 20) return ones[x] + ' ';
    if (x < 100) return tens[Math.floor(x/10)] + (ones[x%10] ? ' ' + ones[x%10] : '') + ' ';
    if (x < 1000) return ones[Math.floor(x/100)] + ' Hundred ' + conv(x % 100);
    if (x < 100000) return conv(Math.floor(x/1000)) + 'Thousand ' + conv(x % 1000);
    if (x < 10000000) return conv(Math.floor(x/100000)) + 'Lakh ' + conv(x % 100000);
    return conv(Math.floor(x/10000000)) + 'Crore ' + conv(x % 10000000);
  }
  return 'Rupees ' + conv(num).trim().replace(/\s+/g, ' ') + ' Only';
}

// ─── PayrollApp ──────────────────────────────────────────────────────────────
class PayrollApp {
  constructor() {
    this.rows      = [];
    this.wbId      = null;
    this.wbName    = 'Payroll Data';
    this.saveStatus= 'saved';
    this.saveTimer = null;
    this.activeTab = 'database';
    this._nextId   = 1;
    this._employees     = [];
    this._aeEntries     = [];
    this._tsCache       = [];
    this._leaveCache    = [];
    this._dbFilterMonth = '';
    this._dbFilterYear  = '';
  }

  async init() {
    this.renderDB(); // empty state initially
    await this._loadEmployees();
    this._loadData(); // populates rows from saved data
    document.addEventListener('keydown', e => { if (e.key === 'Escape') this.closeAddModal(); });
    document.getElementById('add-emp-modal')?.addEventListener('click', e => {
      if (e.target.id === 'add-emp-modal') this.closeAddModal();
    });
  }

  async _loadEmployees() {
    try {
      const list = await api('GET', '/users');
      this._employees = Array.isArray(list) ? list : [];
      this._updateDatalist();
    } catch(e) { this._employees = []; }
  }

  _updateDatalist() {
    let dl = document.getElementById('emp-datalist');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'emp-datalist';
      document.body.appendChild(dl);
    }
    dl.innerHTML = this._employees.map(e => `<option value="${e.name}">`).join('');
  }

  // ── Row factory ─────────────────────────────────────────────────────────
  _newRow() {
    this.rows.push({
      id: this._nextId++,
      name: '', designation: '', month: '', year: new Date().getFullYear(),
      totalDays: 0, allowedLeave: 0, leaveTaken: 0, ctc: 0,
      basic: 0, da: 0, hra: 0, conveyance: 0,
      medicalExpenses: 0, special: 0, bonus: 0, ta: 0,
      pfContribution: 0, professionTax: 0, tds: 0, salaryAdvance: 0,
      gender: '', prefix: 'Mr', authorizedSignatory: 'Director',
      pfApplicable: 'Yes', medicalBillSubmitted: 'No',
      medicalBillAmount: 0, companyName: 'DHPE',
    });
  }

  // ── Computed fields ──────────────────────────────────────────────────────
  // Maximum allowed working days based on leaves
  _calcMaxWd(r) {
    const lt = +r.leaveTaken||0, al = +r.allowedLeave||0, td = +r.totalDays||0;
    return Math.max(0, lt >= al ? td - lt + al : td);
  }
  // Actual worked days — uses manual override (capped at max), else auto-calc
  _wd(r) {
    const max = this._calcMaxWd(r);
    const stored = parseFloat(r.workedDays);
    return (r.workedDays !== null && r.workedDays !== undefined && r.workedDays !== '' && !isNaN(stored))
      ? Math.min(Math.max(0, stored), max)
      : max;
  }
  _cw(r)  {
    const td = +r.totalDays||0;
    return td ? Math.round((+r.conveyance||0) / td * this._wd(r)) : (+r.conveyance||0);
  }
  _tg(r)  {
    return (+r.basic||0)+(+r.da||0)+(+r.hra||0)+this._cw(r)
          +(+r.medicalExpenses||0)+(+r.special||0)+(+r.bonus||0)+(+r.ta||0);
  }
  _td(r)  {
    return (+r.pfContribution||0)+(+r.professionTax||0)+(+r.tds||0)+(+r.salaryAdvance||0);
  }
  _net(r) { return this._tg(r) - this._td(r); }

  // ── Update a cell ────────────────────────────────────────────────────────
  _update(rowId, field, value) {
    const r = this.rows.find(x => x.id === rowId);
    if (!r) return;
    const NUM = ['totalDays','allowedLeave','leaveTaken','workedDays','ctc','basic','da','hra',
      'conveyance','medicalExpenses','special','bonus','ta','pfContribution',
      'professionTax','tds','salaryAdvance','medicalBillAmount','year'];
    r[field] = NUM.includes(field) ? (parseFloat(value)||0) : value;

    // Clamp workedDays to its max immediately on manual edit
    if (field === 'workedDays') {
      const maxWd = this._calcMaxWd(r);
      r.workedDays = Math.min(Math.max(0, r.workedDays), maxWd);
      const el = document.querySelector(`[data-row="${rowId}"][data-field="workedDays"]`);
      if (el && +el.value > maxWd) el.value = maxWd;
    }

    if (field === 'name') {
      const emp = this._employees.find(e => e.name === value);
      if (emp) this._autofill(r, emp);
    }
    if (field === 'month' || field === 'year') {
      this._autoTotalDays(r);
    }

    this._recalc(rowId);
    this._scheduleSave();
  }

  _autofill(r, emp) {
    r.designation     = emp.position || '';
    r.ctc             = emp.baseSalary || 0;
    r.basic           = emp.basicSalary || 0;
    r.da              = emp.da || 0;
    r.hra             = emp.hra || 0;
    r.conveyance      = emp.conveyance || 0;
    r.medicalExpenses = emp.medicalExpenses || 0;
    r.special         = emp.specialAllowance || 0;
    r.bonus           = emp.bonus || 0;
    r.ta              = emp.ta || 0;
    r.allowedLeave    = emp.allowedLeavePerMonth != null ? emp.allowedLeavePerMonth : 2;
    r.pfApplicable    = emp.pfApplicable ? 'Yes' : 'No';
    const g = emp.gender || '';
    r.gender = g && g !== 'unspecified' ? g.charAt(0).toUpperCase() + g.slice(1).toLowerCase() : '';
    r.companyName     = emp.company?.name || r.companyName || 'DHPE';
    if (emp.pfApplicable) {
      r.pfContribution = Math.min(1800, Math.round(((r.basic || 0) + (r.da || 0)) * 0.12));
    }
    this._refreshRow(r);
  }

  _autoTotalDays(r) {
    const MONTHS = {january:1,february:2,march:3,april:4,may:5,june:6,
      july:7,august:8,september:9,october:10,november:11,december:12};
    const idx = MONTHS[(r.month||'').toLowerCase()];
    if (!idx || !r.year) return;
    const days = new Date(r.year, idx, 0).getDate();
    r.totalDays = days;
    const el = document.querySelector(`[data-row="${r.id}"][data-field="totalDays"]`);
    if (el) el.value = days;
  }

  _refreshRow(r) {
    const fields = ['designation','ctc','basic','da','hra','conveyance','medicalExpenses',
      'special','bonus','ta','allowedLeave','pfContribution','companyName'];
    for (const f of fields) {
      const el = document.querySelector(`[data-row="${r.id}"][data-field="${f}"]`);
      if (el) el.value = r[f] ?? '';
    }
    // Update selects
    for (const f of ['pfApplicable','gender']) {
      const el = document.querySelector(`select[data-row="${r.id}"][data-field="${f}"]`);
      if (el) el.value = r[f] ?? '';
    }
  }

  _recalc(rowId) {
    const r = this.rows.find(x => x.id === rowId);
    if (!r) return;
    const set = (f, v) => {
      const el = document.querySelector(`[data-row="${rowId}"][data-field="${f}"]`);
      if (el) el.value = v;
    };
    // Update workedDays: enforce max, auto-reset when totalDays/leaveTaken/allowedLeave changes
    const maxWd = this._calcMaxWd(r);
    const wdEl  = document.querySelector(`[data-row="${rowId}"][data-field="workedDays"]`);
    if (wdEl) {
      wdEl.max = maxWd;
      if (+wdEl.value > maxWd || wdEl.value === '') {
        wdEl.value   = maxWd;
        r.workedDays = maxWd;
      }
    }
    set('convWorking', this._cw(r));
    set('totalGross',  this._tg(r));
    set('totalDed',    this._td(r));
    set('netPay',      this._net(r));
  }

  // ── Row HTML ─────────────────────────────────────────────────────────────
  _rowHTML(r, sl) {
    const MONTH_OPTS = ['january','february','march','april','may','june',
      'july','august','september','october','november','december'];
    const n  = (f, t='text', v=r[f]) =>
      `<input type="${t}" class="ci" data-row="${r.id}" data-field="${f}" value="${v??''}" ${t==='number'?'min="0" step="any"':''} readonly tabindex="-1">`;
    const au = (f, v, extra='') =>
      `<input type="number" class="ci auto-cell ${extra}" data-row="${r.id}" data-field="${f}" value="${v??0}" readonly tabindex="-1">`;
    const sel = (f, opts) =>
      `<select class="ci" data-row="${r.id}" data-field="${f}" disabled>${opts.map(o=>`<option ${r[f]===o?'selected':''}>${o}</option>`).join('')}</select>`;
    const monthSel = () => {
      const cur = (r.month||'').toLowerCase();
      return `<select class="ci ci-month" data-row="${r.id}" data-field="month" disabled>
        <option value="">—</option>
        ${MONTH_OPTS.map(m=>`<option value="${m}"${cur===m?' selected':''}>${m.charAt(0).toUpperCase()+m.slice(1)}</option>`).join('')}
      </select>`;
    };

    return `<tr data-dbrow="${r.id}">
      <td class="sl-col">${sl}</td>
      <td class="del-col"><button class="db-del-btn" data-del-id="${r.id}" title="Delete this row"><i class="bx bx-trash"></i></button></td>
      <td class="edit-col"><button class="db-edit-btn" data-edit-id="${r.id}" title="Edit this row"><i class="bx bx-edit"></i></button></td>
      <td class="name-col"><input type="text" class="ci" data-row="${r.id}" data-field="name" value="${r.name||''}" list="emp-datalist" autocomplete="off" readonly tabindex="-1"></td>
      <td>${n('designation')}</td>
      <td>${monthSel()}</td>
      <td>${n('year','number',r.year)}</td>
      <td>${n('totalDays','number',r.totalDays)}</td>
      <td>${n('allowedLeave','number',r.allowedLeave)}</td>
      <td>${n('leaveTaken','number',r.leaveTaken)}</td>
      <td><input type="number" class="ci auto-cell auto-wd" data-row="${r.id}" data-field="workedDays" value="${this._wd(r)}" min="0" max="${this._calcMaxWd(r)}" step="1" title="Max ${this._calcMaxWd(r)} days"></td>
      <td>${n('ctc','number',r.ctc)}</td>
      <td class="gross-zone">${n('basic','number',r.basic)}</td>
      <td class="gross-zone">${n('da','number',r.da)}</td>
      <td class="gross-zone">${n('hra','number',r.hra)}</td>
      <td class="gross-zone">${n('conveyance','number',r.conveyance)}</td>
      <td class="gross-zone">${au('convWorking',this._cw(r),'auto-blue')}</td>
      <td class="gross-zone">${n('medicalExpenses','number',r.medicalExpenses)}</td>
      <td class="gross-zone">${n('special','number',r.special)}</td>
      <td class="gross-zone">${n('bonus','number',r.bonus)}</td>
      <td class="gross-zone">${n('ta','number',r.ta)}</td>
      <td class="gross-zone">${au('totalGross',this._tg(r),'auto-green')}</td>
      <td class="ded-zone">${n('pfContribution','number',r.pfContribution)}</td>
      <td class="ded-zone">${n('professionTax','number',r.professionTax)}</td>
      <td class="ded-zone">${n('tds','number',r.tds)}</td>
      <td class="ded-zone">${n('salaryAdvance','number',r.salaryAdvance)}</td>
      <td class="ded-zone">${au('totalDed',this._td(r),'auto-red')}</td>
      <td>${au('netPay',this._net(r),'auto-net')}</td>
      <td>${sel('gender',['','Male','Female','Other'])}</td>
      <td>${sel('prefix',['Mr','Mrs','Ms','Dr'])}</td>
      <td>${n('authorizedSignatory')}</td>
      <td>${sel('pfApplicable',['Yes','No'])}</td>
      <td>${sel('medicalBillSubmitted',['No','Yes'])}</td>
      <td>${n('medicalBillAmount','number',r.medicalBillAmount)}</td>
      <td>${n('companyName','text',r.companyName)}</td>
    </tr>`;
  }

  _bindRow(tr) {
    // Wire change/input events (only fire when not readonly/disabled)
    tr.querySelectorAll('input[data-row],select[data-row]').forEach(el => {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, e =>
        this._update(+e.target.dataset.row, e.target.dataset.field, e.target.value)
      );
    });

    // Edit button — toggles row between view and edit mode
    const editBtn = tr.querySelector('.db-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const editing = tr.classList.toggle('row-editing');
        editBtn.innerHTML = editing
          ? '<i class="bx bx-check"></i>'
          : '<i class="bx bx-edit"></i>';
        editBtn.title = editing ? 'Done editing' : 'Edit this row';
        editBtn.classList.toggle('db-edit-btn--active', editing);
        // Enable/disable all cell inputs and selects
        tr.querySelectorAll('input[data-row]').forEach(el => {
          const isAuto = el.classList.contains('auto-cell');
          el.readOnly  = !editing || isAuto;
          el.tabIndex  = (!editing || isAuto) ? -1 : 0;
        });
        tr.querySelectorAll('select[data-row]').forEach(el => {
          el.disabled = !editing;
        });
        if (!editing) {
          // Save on done
          this._scheduleSave();
          this._renderSlipSelector();
        }
      });
    }
  }

  // ── Delete a row from the database ──────────────────────────────────────
  deleteRow(rowId) {
    const id = String(rowId);
    const idx = this.rows.findIndex(x => String(x.id) === id);
    if (idx === -1) return;
    const name = this.rows[idx].name || 'this entry';
    this.rows.splice(idx, 1);
    this.renderDB();
    this._scheduleSave();
    this._renderSlipSelector();
    toast(`Deleted payroll entry for ${name}`, 'info');
  }

  // ── Render Database tab ──────────────────────────────────────────────────
  renderDB() {
    const tbody = document.getElementById('db-tbody');
    if (!tbody) return;
    this._updateDatalist();
    this._updateYearFilter();

    const fm = (this._dbFilterMonth || '').toLowerCase();
    const fy = this._dbFilterYear  || '';
    const visible = this.rows.filter(r => {
      if (fm && (r.month||'').toLowerCase() !== fm) return false;
      if (fy && String(r.year) !== fy) return false;
      return true;
    });

    // Update count badge
    const countEl = document.getElementById('db-filter-count');
    if (countEl) {
      if (fm || fy) {
        countEl.textContent = `${visible.length} of ${this.rows.length} record${this.rows.length !== 1 ? 's' : ''}`;
      } else {
        countEl.textContent = this.rows.length ? `${this.rows.length} record${this.rows.length !== 1 ? 's' : ''}` : '';
      }
    }

    if (visible.length === 0) {
      const msg = (fm || fy)
        ? `No payroll entries for ${fm ? fm.charAt(0).toUpperCase()+fm.slice(1) : 'any month'}${fy ? ' '+fy : ''}`
        : 'No payroll entries yet';
      const hint = (fm || fy)
        ? '<small>Try a different filter or <button class="db-pill" onclick="payroll.clearDbFilter()" style="display:inline;padding:2px 8px;">Clear filters</button></small>'
        : '<small>Click <strong>Add Employee</strong> in the toolbar to get started</small>';
      tbody.innerHTML = `<tr><td colspan="35" style="padding:0;border:none;">
        <div class="db-empty-state">
          <i class="bx bx-${fm || fy ? 'search' : 'user-plus'}"></i>
          <p>${msg}</p>${hint}
        </div>
      </td></tr>`;
      return;
    }

    tbody.innerHTML = visible.map((r, i) => this._rowHTML(r, i+1)).join('');
    tbody.querySelectorAll('tr').forEach(tr => this._bindRow(tr));
    tbody.querySelectorAll('.db-del-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const id = +btn.dataset.delId;
        if (id) this.deleteRow(id);
      });
    });
  }

  // ── DB filter methods ────────────────────────────────────────────────────
  setDbMonth(month) {
    this._dbFilterMonth = month;
    document.querySelectorAll('.db-pill[data-month]').forEach(p =>
      p.classList.toggle('active', p.dataset.month === month)
    );
    this.renderDB();
  }

  setDbYear(year) {
    this._dbFilterYear = year;
    this.renderDB();
  }

  clearDbFilter() {
    this._dbFilterMonth = '';
    this._dbFilterYear  = '';
    document.querySelectorAll('.db-pill[data-month]').forEach(p =>
      p.classList.toggle('active', p.dataset.month === '')
    );
    const sel = document.getElementById('db-year-filter');
    if (sel) sel.value = '';
    this.renderDB();
  }

  _updateYearFilter() {
    const sel = document.getElementById('db-year-filter');
    if (!sel) return;
    const years = [...new Set(this.rows.map(r => r.year).filter(Boolean))].sort((a,b)=>b-a);
    const cur = this._dbFilterYear;
    sel.innerHTML = '<option value="">All Years</option>'
      + years.map(y => `<option value="${y}"${String(y)===cur?' selected':''}>${y}</option>`).join('');
  }

  // ── Add Employee Modal (timesheet-style) ────────────────────────────────
  openAddModal() {
    this._aeEntries = [];
    document.getElementById('ae-month').value        = '';
    document.getElementById('ae-year').value         = new Date().getFullYear();
    document.getElementById('ae-notes-txt').value    = '';
    document.getElementById('ae-tbody').innerHTML    = '';
    document.getElementById('ae-banner').style.display     = 'flex';
    document.getElementById('ae-totals-row').style.display = 'none';
    document.getElementById('add-emp-modal').style.display = 'flex';
    this._aeUpdateStats();
    // Pre-load timesheets + leaves in background for attendance summary
    Promise.all([
      api('GET', '/timesheets').catch(() => []),
      api('GET', '/leaves').catch(() => []),
    ]).then(([ts, lv]) => {
      this._tsCache    = Array.isArray(ts) ? ts : [];
      this._leaveCache = Array.isArray(lv) ? lv : [];
    });
  }

  closeAddModal() {
    document.getElementById('add-emp-modal').style.display = 'none';
    // Reset filter
    const filterInput = document.getElementById('ae-filter-input');
    if (filterInput) filterInput.value = '';
    this._updateDatalist();
  }

  // ── Filter employees in the datalist ────────────────────────────────────
  _aeFilterEmployees(query) {
    const q = (query || '').toLowerCase().trim();
    let dl = document.getElementById('emp-datalist');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'emp-datalist';
      document.body.appendChild(dl);
    }
    if (!q) {
      dl.innerHTML = this._employees.map(e => `<option value="${e.name}">`).join('');
      return;
    }
    const filtered = this._employees.filter(e =>
      (e.name || '').toLowerCase().includes(q) ||
      (e.position || '').toLowerCase().includes(q) ||
      (e.email || '').toLowerCase().includes(q)
    );
    dl.innerHTML = filtered.map(e => `<option value="${e.name}">`).join('');
  }

  // ── Modal worked-days helpers ────────────────────────────────────────────
  _aeMaxWd(idx) {
    const e = this._aeEntries[idx];
    if (!e) return 0;
    const td = +e.totalDays || 0;
    const lt = +e.leaveTaken || 0;
    const al = +(e._emp?.allowedLeavePerMonth ?? 2);
    return Math.max(0, lt >= al ? td - lt + al : td);
  }

  _aeRefreshWd(idx) {
    const max   = this._aeMaxWd(idx);
    const wdEl  = document.querySelector(`[data-ae="${idx}"][data-f="workedDays"]`);
    if (!wdEl) return;
    wdEl.max = max;
    const cur = +wdEl.value;
    if (isNaN(cur) || cur > max) {
      wdEl.value = max;
      if (this._aeEntries[idx]) this._aeEntries[idx].workedDays = max;
    }
  }

  _aeTotalDays() {
    const MONTHS = {january:1,february:2,march:3,april:4,may:5,june:6,
      july:7,august:8,september:9,october:10,november:11,december:12};
    const m = (document.getElementById('ae-month').value||'').toLowerCase();
    const y = +document.getElementById('ae-year').value || 0;
    const idx = MONTHS[m];
    return (idx && y) ? new Date(y, idx, 0).getDate() : 0;
  }

  _aeMonthYearChange() {
    const days = this._aeTotalDays();
    const month = document.getElementById('ae-month').value;
    const year  = +document.getElementById('ae-year').value || new Date().getFullYear();
    this._aeEntries.forEach((e, i) => {
      if (!e) return;
      e.totalDays = days;
      const el = document.querySelector(`[data-ae="${i}"][data-f="totalDays"]`);
      if (el) el.value = days || '';
      // Refresh workedDays max when month/year changes
      this._aeRefreshWd(i);
      // Refresh attendance summary for each matched employee
      if (e._emp) {
        this._aeShowAttendance(i, e._emp, month, year);
      }
      // Re-run duplicate detection
      if (e.name) this._aeNameFill(i, e.name);
    });
    this._aeUpdateTotals();
  }

  _aeAddEntry() {
    const days = this._aeTotalDays();
    const idx  = this._aeEntries.length;
    this._aeEntries.push({ name:'', designation:'', totalDays:days, leaveTaken:0, workedDays:days, salaryAdvance:0, tds:0, ctc:0, _emp:null });
    document.getElementById('ae-banner').style.display = 'none';
    document.getElementById('ae-totals-row').style.display = '';

    const tbody = document.getElementById('ae-tbody');
    const tr = document.createElement('tr');
    tr.dataset.aeRow = idx;
    tr.innerHTML = `
      <td>
        <input type="text" class="ae-ci" data-ae="${idx}" data-f="name"
               list="emp-datalist" placeholder="Employee name…" autocomplete="off"
               value="">
        <div class="ae-sub-label" id="ae-sub-${idx}"></div>
      </td>
      <td>
        <input type="text" class="ae-ci ae-ci-auto" data-ae="${idx}" data-f="designation"
               placeholder="Auto-filled" value="">
      </td>
      <td>
        <input type="number" class="ae-ci ae-ci-num ae-ci-auto" data-ae="${idx}" data-f="totalDays"
               value="${days||''}" placeholder="—" min="0">
      </td>
      <td>
        <input type="number" class="ae-ci ae-ci-num" data-ae="${idx}" data-f="leaveTaken"
               value="0" min="0">
      </td>
      <td>
        <input type="number" class="ae-ci ae-ci-num ae-ci-wd" data-ae="${idx}" data-f="workedDays"
               value="${days||0}" min="0" max="${days||0}">
      </td>
      <td>
        <input type="number" class="ae-ci ae-ci-num" data-ae="${idx}" data-f="salaryAdvance"
               value="0" min="0">
      </td>
      <td>
        <input type="number" class="ae-ci ae-ci-num" data-ae="${idx}" data-f="tds"
               value="0" min="0">
      </td>
      <td>
        <input type="number" class="ae-ci ae-ci-num ae-ci-auto" data-ae="${idx}" data-f="ctc"
               value="0" readonly>
      </td>
      <td>
        <button class="ae-del-btn" onclick="payroll._aeRemoveEntry(${idx})">
          <i class="bx bx-trash"></i>
        </button>
      </td>`;
    tbody.appendChild(tr);

    // Bind inputs
    tr.querySelectorAll('[data-ae]').forEach(el => {
      const ev = el.getAttribute('type') === 'text' ? 'input' : 'change';
      el.addEventListener(ev, () => {
        const i = +el.dataset.ae, f = el.dataset.f;
        if (f === 'name') { this._aeNameFill(i, el.value); }
        else {
          this._aeEntries[i][f] = f==='designation' ? el.value : (+el.value||0);
          // When leaveTaken or totalDays changes, update workedDays max and clamp
          if (f === 'leaveTaken' || f === 'totalDays') {
            this._aeRefreshWd(i);
          }
          // When workedDays is manually changed, clamp to max
          if (f === 'workedDays') {
            const max = this._aeMaxWd(i);
            if (this._aeEntries[i].workedDays > max) {
              this._aeEntries[i].workedDays = max;
              el.value = max;
            }
          }
          this._aeUpdateTotals();
        }
      });
    });

    this._aeUpdateStats();
    setTimeout(() => tr.querySelector('input').focus(), 30);
  }

  _aeNameFill(idx, value) {
    const e   = this._aeEntries[idx];
    const emp = this._employees.find(x => x.name === value);
    e.name    = value;
    e._emp    = emp || null;

    const desigEl = document.querySelector(`[data-ae="${idx}"][data-f="designation"]`);
    const ctcEl   = document.querySelector(`[data-ae="${idx}"][data-f="ctc"]`);
    const subEl   = document.getElementById(`ae-sub-${idx}`);

    // ── Duplicate detection ──────────────────────────────────
    const month = document.getElementById('ae-month').value;
    const year  = +document.getElementById('ae-year').value || new Date().getFullYear();
    const dupBatch = value && this._aeEntries.some((x, i) => i !== idx && x && x.name === value);
    const dupSaved = value && this.rows.some(r =>
      r.name === value &&
      (r.month||'').toLowerCase() === (month||'').toLowerCase() &&
      +r.year === year
    );

    if ((dupBatch || dupSaved) && value) {
      if (subEl) {
        subEl.innerHTML = `<span class="ae-dup-warn">⚠ "${value}" already added${dupSaved?' for '+month+' '+year:' in this batch'} — duplicate!</span>`;
      }
      e._isDup = true;
    } else {
      e._isDup = false;
      if (emp) {
        e.designation = emp.position || '';
        e.ctc         = emp.baseSalary || 0;
        if (desigEl) { desigEl.value = e.designation; desigEl.classList.add('ae-ci-found'); }
        if (ctcEl)   { ctcEl.value   = e.ctc;         ctcEl.classList.add('ae-ci-found'); }
        if (subEl)   { subEl.innerHTML = '<span style="color:#16a34a;font-size:10px;font-weight:600;">✓ Salary auto-filled</span>'; }
        // Show attendance summary
        this._aeShowAttendance(idx, emp, month, year);
      } else {
        e.designation = '';
        e.ctc         = 0;
        if (desigEl) { desigEl.value = ''; desigEl.classList.remove('ae-ci-found'); }
        if (ctcEl)   { ctcEl.value   = 0;  ctcEl.classList.remove('ae-ci-found'); }
        if (subEl)   { subEl.innerHTML = ''; }
        this._aeHideAttendance(idx);
      }
    }
    this._aeUpdateTotals();
    this._aeUpdateStats();
  }

  // ── Attendance summary ───────────────────────────────────────────────────
  _aeCalcAttendance(empId, monthName, year) {
    const MONTHS = {january:1,february:2,march:3,april:4,may:5,june:6,
      july:7,august:8,september:9,october:10,november:11,december:12};
    const monthIdx = MONTHS[(monthName||'').toLowerCase()];
    if (!monthIdx || !year) return null;

    const calDays    = new Date(year, monthIdx, 0).getDate();
    const monthStart = new Date(year, monthIdx-1, 1);
    const monthEnd   = new Date(year, monthIdx-1, calDays);

    // Working days — check if weekends should be included
    const includeWeekends = document.getElementById('ae-include-weekends')?.checked || false;
    let workingDays = 0;
    for (let d = 1; d <= calDays; d++) {
      const dow = new Date(year, monthIdx-1, d).getDay();
      if (includeWeekends || (dow !== 0 && dow !== 6)) workingDays++;
    }

    // Timesheets for this employee
    const empTs = this._tsCache.filter(t =>
      t.userId === empId &&
      new Date(t.weekEnd)   >= monthStart &&
      new Date(t.weekStart) <= monthEnd
    );
    const presentDates = new Set();
    let hoursWorked = 0;
    empTs.forEach(t => {
      (t.entries || []).forEach(e => {
        const d = new Date((e.date||'') + 'T00:00:00');
        if (d >= monthStart && d <= monthEnd && (+e.hours||0) > 0) {
          presentDates.add(e.date);
          hoursWorked += +e.hours || 0;
        }
      });
    });
    const present = presentDates.size;

    // Leaves
    const HOLIDAY_TYPES = ['holiday', 'festival', 'company_event'];
    let leaveDays = 0, holidayDays = 0;
    this._leaveCache.forEach(l => {
      if (l.status !== 'approved') return;
      const s = new Date(l.startDate), end = new Date(l.endDate);
      const from = s > monthStart ? s : monthStart;
      const to   = end < monthEnd  ? end : monthEnd;
      if (from > to) return;
      let days = 0;
      for (let d = new Date(from); d <= to; d.setDate(d.getDate()+1)) days++;
      if (HOLIDAY_TYPES.includes(l.type)) holidayDays += days;
      else if (l.userId === empId)        leaveDays   += days;
    });

    const absent = Math.max(0, workingDays - present - leaveDays - holidayDays);
    return { calDays, present, absent, leaveDays, holidayDays, workingDays, hoursWorked };
  }

  _aeShowAttendance(idx, emp, month, year) {
    const attRowId = `ae-att-row-${idx}`;
    let attRow = document.getElementById(attRowId);
    if (!attRow) {
      const entryRow = document.querySelector(`[data-ae-row="${idx}"]`);
      if (!entryRow) return;
      attRow = document.createElement('tr');
      attRow.id = attRowId;
      attRow.className = 'ae-att-row';
      entryRow.after(attRow);
    }

    const summary = this._aeCalcAttendance(emp.id, month, year);
    const monthLabel = month ? `${month} ${year}` : `${year}`;

    if (!summary) {
      attRow.innerHTML = `<td colspan="8"><div class="ae-att-card">
        <div class="ae-att-header"><i class="bx bxs-calendar-check"></i><span class="ae-att-month">Employee Attendance Summary</span></div>
        <span style="color:#6b7280;font-size:12px;">Select a month &amp; year above to view attendance data for <strong>${emp.name||'this employee'}</strong>.</span>
      </div></td>`;
    } else {
      const items = [
        { v: summary.calDays,     l: 'Cal. Days' },
        { v: summary.present,     l: 'Present' },
        { v: summary.absent,      l: 'Absent' },
        { v: summary.leaveDays,   l: 'Leaves' },
        { v: summary.holidayDays, l: 'Holidays' },
        { v: summary.workingDays + ' days', l: 'Working Days' },
        { v: summary.hoursWorked.toFixed(1)+' hrs', l: 'Hours Worked' },
      ];
      attRow.innerHTML = `<td colspan="8"><div class="ae-att-card">
        <div class="ae-att-header"><i class="bx bxs-calendar-check"></i><span class="ae-att-month">${monthLabel}</span></div>
        <div class="ae-att-items">${items.map(x=>`
          <div class="ae-att-item">
            <span class="ae-att-val">${x.v}</span>
            <span class="ae-att-lbl">${x.l}</span>
          </div>`).join('')}
        </div>
      </div></td>`;
    }
  }

  _aeHideAttendance(idx) {
    document.getElementById(`ae-att-row-${idx}`)?.remove();
  }

  _aeRemoveEntry(idx) {
    const tbody = document.getElementById('ae-tbody');
    const tr    = tbody.querySelector(`[data-ae-row="${idx}"]`);
    if (tr) tr.remove();
    // Also remove the attendance summary row
    this._aeHideAttendance(idx);
    this._aeEntries[idx] = null;
    const active = this._aeEntries.filter(Boolean);
    if (active.length === 0) {
      document.getElementById('ae-banner').style.display     = 'flex';
      document.getElementById('ae-totals-row').style.display = 'none';
    }
    this._aeUpdateTotals();
    this._aeUpdateStats();
  }

  _aeUpdateTotals() {
    const entries = this._aeEntries.filter(Boolean);
    const sum = f => entries.reduce((s,e) => s + (+e[f]||0), 0);
    const setEl = (id, v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
    setEl('ae-tot-days',  entries.length ? this._aeTotalDays()||'—' : '—');
    setEl('ae-tot-leave', sum('leaveTaken'));
    setEl('ae-tot-wd',    entries.length ? sum('workedDays') : '—');
    setEl('ae-tot-adv',   sum('salaryAdvance'));
    setEl('ae-tot-tds',   sum('tds'));
    setEl('ae-tot-ctc',   sum('ctc').toLocaleString('en-IN'));
  }

  _aeUpdateStats() {
    const entries = this._aeEntries.filter(Boolean);
    const named   = entries.filter(e => e.name).length;
    const setEl = (id, v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
    setEl('ae-stat-emp',  `${named} employee${named!==1?'s':''}`);
    setEl('ae-stat-rows', `${entries.length} row(s)`);
    setEl('ae-stat-ctc',  `₹${entries.reduce((s,e)=>s+(+e.ctc||0),0).toLocaleString('en-IN')} total CTC`);
  }

  submitAddEmployee() {
    const month = document.getElementById('ae-month').value;
    const year  = +document.getElementById('ae-year').value || new Date().getFullYear();
    const valid = this._aeEntries.filter(Boolean).filter(e => e.name.trim());

    if (!month) {
      if (typeof toast === 'function') toast('Please select a month before adding to payroll.', 'error');
      else alert('Please select a month before adding to payroll.');
      return;
    }

    if (!valid.length) {
      document.getElementById('ae-banner').style.display = 'flex';
      document.getElementById('ae-banner').style.background = '#fef2f2';
      document.getElementById('ae-banner').style.borderColor = '#fecaca';
      document.getElementById('ae-banner').querySelector('span').textContent = 'Please add at least one employee before submitting.';
      return;
    }

    // ── Duplicate prevention ──────────────────────────────────
    // Check for duplicates within the batch (same name appearing multiple times)
    const batchNames = valid.map(e => e.name.trim().toLowerCase());
    const batchDuplicates = batchNames.filter((n, i) => batchNames.indexOf(n) !== i);

    // Check for duplicates against already-saved rows (same name + same month + same year)
    const savedDuplicates = valid.filter(e =>
      this.rows.some(r =>
        r.name.trim().toLowerCase() === e.name.trim().toLowerCase() &&
        (r.month||'').toLowerCase() === month.toLowerCase() &&
        +r.year === year
      )
    ).map(e => e.name);

    const allDups = [...new Set([...batchDuplicates.map(n => valid.find(e => e.name.trim().toLowerCase() === n)?.name || n), ...savedDuplicates])];

    if (allDups.length > 0) {
      const dupMsg = `Duplicate entries found for: ${allDups.join(', ')} (${month} ${year}). Please remove duplicates before submitting.`;
      if (typeof toast === 'function') toast(dupMsg, 'error');
      else alert(dupMsg);
      return;
    }

    valid.forEach(e => {
      const emp = e._emp;
      const r = {
        id: this._nextId++,
        name: e.name, month, year,
        totalDays: e.totalDays || this._aeTotalDays() || 0,
        leaveTaken: e.leaveTaken || 0,
        workedDays: e.workedDays !== undefined ? e.workedDays : null,
        salaryAdvance: e.salaryAdvance || 0,
        tds: e.tds || 0,
        designation: e.designation || '',
        ctc: e.ctc || 0,
        basic:0, da:0, hra:0, conveyance:0, medicalExpenses:0, special:0, bonus:0, ta:0,
        allowedLeave:2, pfContribution:0, professionTax:0,
        gender:'', prefix:'Mr', authorizedSignatory:'Director',
        pfApplicable:'Yes', medicalBillSubmitted:'No',
        medicalBillAmount:0, companyName:'DHPE',
      };
      if (emp) {
        r.basic           = emp.basicSalary     || 0;
        r.da              = emp.da              || 0;
        r.hra             = emp.hra             || 0;
        r.conveyance      = emp.conveyance      || 0;
        r.medicalExpenses = emp.medicalExpenses || 0;
        r.special         = emp.specialAllowance|| 0;
        r.bonus           = emp.bonus           || 0;
        r.ta              = emp.ta              || 0;
        r.allowedLeave    = emp.allowedLeavePerMonth ?? 2;
        r.pfApplicable    = emp.pfApplicable ? 'Yes' : 'No';
        const g = emp.gender||'';
        r.gender          = g && g !== 'unspecified' ? g.charAt(0).toUpperCase()+g.slice(1) : '';
        r.companyName     = emp.company?.name || 'DHPE';
        if (emp.pfApplicable) r.pfContribution = Math.min(1800, Math.round((r.basic+r.da)*0.12));
      }
      this.rows.push(r);
    });

    this.closeAddModal();
    this.renderDB();
    this._scheduleSave();
    this._renderSlipSelector();
  }

  // ── Tab navigation ───────────────────────────────────────────────────────
  goToTab(tab) {
    this.activeTab = tab;
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + tab)?.classList.add('active');
    document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');
    if (tab === 'consolidation') this._renderConsolidation();
    if (tab === 'salary-slip')   this._renderSlipSelector();
  }

  // ── Consolidation ────────────────────────────────────────────────────────
  _renderConsolidation() {
    const el = document.getElementById('consolidation-body');
    if (!el) return;

    const fm = (document.getElementById('cons-filter-month')?.value || '').trim().toLowerCase();
    const fy = (document.getElementById('cons-filter-year')?.value  || '').trim();

    const data = this.rows.filter(r => {
      if (!r.name) return false;
      if (fm && (r.month||'').toLowerCase() !== fm) return false;
      if (fy && String(r.year) !== fy) return false;
      return true;
    });

    const sum = f => data.reduce((s, r) => s + (+r[f]||0), 0);
    const totalNet = data.reduce((s, r) => s + this._net(r), 0);

    const EMPTY_ROWS = Math.max(0, 20 - data.length);
    const empty16 = '<td>&nbsp;</td>'.repeat(16);

    el.innerHTML = `
      <table class="cons-table" id="cons-print-table">
        <thead>
          <tr>
            <th rowspan="2" class="hdr-plain">Sl</th>
            <th rowspan="2" class="hdr-plain" style="min-width:120px;">Name of Employee</th>
            <th rowspan="2" class="hdr-plain">CTC</th>
            <th colspan="8" class="hdr-gross">TOTAL GROSS SALARY</th>
            <th colspan="4" class="hdr-ded">TOTAL DEDUCTIONS</th>
            <th colspan="1" class="hdr-net">NET PAY</th>
          </tr>
          <tr>
            <th class="hdr-gross">Basic</th>
            <th class="hdr-gross">DA</th>
            <th class="hdr-gross">HRA</th>
            <th class="hdr-gross">Conv</th>
            <th class="hdr-gross">Medic.</th>
            <th class="hdr-gross">Spec.</th>
            <th class="hdr-gross">Bonus</th>
            <th class="hdr-gross">TA</th>
            <th class="hdr-ded">Contrib.<br>PF</th>
            <th class="hdr-ded">Prof.<br>Tax</th>
            <th class="hdr-ded">TDS</th>
            <th class="hdr-ded">Salary<br>Adv.</th>
            <th class="hdr-net">NET<br>PAY</th>
          </tr>
        </thead>
        <tbody>
          ${data.map((r,i) => `<tr>
            <td class="num">${i+1}</td>
            <td style="text-align:left;padding-left:6px;">${r.name}</td>
            <td class="num">${r.ctc||0}</td>
            <td class="num">${r.basic||0}</td>
            <td class="num">${r.da||0}</td>
            <td class="num">${r.hra||0}</td>
            <td class="num">${this._cw(r)}</td>
            <td class="num">${r.medicalExpenses||0}</td>
            <td class="num">${r.special||0}</td>
            <td class="num">${r.bonus||0}</td>
            <td class="num">${r.ta||0}</td>
            <td class="num">${r.pfContribution||0}</td>
            <td class="num">${r.professionTax||0}</td>
            <td class="num">${r.tds||0}</td>
            <td class="num">${r.salaryAdvance||0}</td>
            <td class="num net-val">${this._net(r)}</td>
          </tr>`).join('')}
          ${Array(EMPTY_ROWS).fill(`<tr>${empty16}</tr>`).join('')}
        </tbody>
        <tfoot>
          <tr class="cons-total-row">
            <td colspan="2" style="text-align:right;font-weight:700;">Total</td>
            <td class="num">${sum('ctc')}</td>
            <td class="num">${sum('basic')}</td>
            <td class="num">${sum('da')}</td>
            <td class="num">${sum('hra')}</td>
            <td class="num">${data.reduce((s,r)=>s+this._cw(r),0)}</td>
            <td class="num">${sum('medicalExpenses')}</td>
            <td class="num">${sum('special')}</td>
            <td class="num">${sum('bonus')}</td>
            <td class="num">${sum('ta')}</td>
            <td class="num">${sum('pfContribution')}</td>
            <td class="num">${sum('professionTax')}</td>
            <td class="num">${sum('tds')}</td>
            <td class="num">${sum('salaryAdvance')}</td>
            <td class="num net-val"><strong>${totalNet}</strong></td>
          </tr>
        </tfoot>
      </table>
      <div class="cons-bottom">
        <div class="cons-words">${numberToWords(totalNet)}</div>
        <div class="cons-sign">
          <div>Authorised by Director</div>
          <div class="sign-blank">Signature &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</div>
        </div>
      </div>
    `;
  }

  applyConsFilter() { this._renderConsolidation(); }

  // ── Salary Slip selector ─────────────────────────────────────────────────
  _renderSlipSelector() {
    const sel = document.getElementById('slip-emp-select');
    if (!sel) return;

    const fm = (document.getElementById('slip-filter-month')?.value || '').trim().toLowerCase();
    const fy = (document.getElementById('slip-filter-year')?.value || '').trim();

    const dataRows = this.rows.filter(r => {
      if (!r.name) return false;
      if (fm && (r.month||'').toLowerCase() !== fm) return false;
      if (fy && String(r.year) !== fy) return false;
      return true;
    });

    sel.innerHTML = '<option value="">— Select Employee —</option>'
      + dataRows.map(r => `<option value="${r.id}">${r.name} (${r.month||'—'} ${r.year||''})</option>`).join('');

    // Auto-select first result and show slip
    if (dataRows.length > 0) {
      sel.value = String(dataRows[0].id);
      this.showSlip(dataRows[0].id);
    } else {
      document.getElementById('slip-display').innerHTML =
        '<div class="slip-empty-msg">No payroll entries match the selected filter.</div>';
    }
  }

  _applySlipFilter() {
    this._renderSlipSelector();
  }

  showSlip(rowId) {
    const r = this.rows.find(x => x.id === +rowId || String(x.id) === String(rowId));
    const el = document.getElementById('slip-display');
    if (!el) return;
    if (!r) { el.innerHTML = '<div class="slip-empty-msg">Select an employee to view their salary slip.</div>'; return; }

    const wd    = this._wd(r);
    const cw    = this._cw(r);
    const tg    = this._tg(r);
    const td    = this._td(r);
    const np    = this._net(r);
    const present = wd;
    const fmt    = (v) => `₹ ${(+v||0).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
    const fmtAmt = fmt;
    const fmtDed = fmt;
    const today = new Date();
    const genDate = today.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

    // Find the employee to get additional details
    const emp = this._employees.find(e => e.name === r.name);

    el.innerHTML = `
    <div class="salary-slip" id="printable-slip">
      <!-- Company Header -->
      <div class="ss-company-header">
        <div class="ss-co-name">${r.companyName || 'DHPE'}</div>
        <div class="ss-co-addr">${emp?.company?.address || '182/1 Purbachal, Rahara, Khardaha, North 24 PGS, Kolkata, West Bengal, Pin-700118'}</div>
        <div class="ss-co-contact">${emp?.company?.phone || '+91-9876543210'} | ${emp?.company?.email || 'contact@dhpe.in'}</div>
      </div>

      <!-- Salary Slip Title -->
      <div class="ss-title-bar">
        <div class="ss-title">SALARY SLIP</div>
        <div class="ss-subtitle">For the month of ${r.month || '—'} ${r.year || ''}</div>
      </div>

      <!-- Employee Details Grid -->
      <div class="ss-emp-grid">
        <div class="ss-emp-row">
          <span class="ss-label">Employee Name:</span>
          <span class="ss-value">${r.prefix || ''} ${r.name}</span>
          <span class="ss-label">Employee Code:</span>
          <span class="ss-value">${emp?.employeeCode || 'EMP-' + String(r.id).padStart(4, '0')}</span>
        </div>
        <div class="ss-emp-row">
          <span class="ss-label">Department:</span>
          <span class="ss-value">${emp?.department || '—'}</span>
          <span class="ss-label">Designation:</span>
          <span class="ss-value">${r.designation || '—'}</span>
        </div>
        <div class="ss-emp-row">
          <span class="ss-label">Email:</span>
          <span class="ss-value">${emp?.email || '—'}</span>
          <span class="ss-label">Phone:</span>
          <span class="ss-value">${emp?.phone || '—'}</span>
        </div>
        <div class="ss-emp-row">
          <span class="ss-label">Month:</span>
          <span class="ss-value">${r.month || '—'} ${r.year || ''}</span>
          <span class="ss-label">CTC:</span>
          <span class="ss-value">${fmtAmt(r.ctc)}</span>
        </div>
      </div>

      <!-- Attendance Stats Boxes -->
      <div class="ss-att-boxes">
        <div class="ss-att-box">
          <div class="ss-att-label">Total Days</div>
          <div class="ss-att-val">${r.totalDays || 0}</div>
        </div>
        <div class="ss-att-box">
          <div class="ss-att-label">Leave Taken</div>
          <div class="ss-att-val">${r.leaveTaken || 0}</div>
        </div>
        <div class="ss-att-box">
          <div class="ss-att-label">Worked Days</div>
          <div class="ss-att-val">${wd}</div>
        </div>
        <div class="ss-att-box">
          <div class="ss-att-label">Present Days</div>
          <div class="ss-att-val">${present}</div>
        </div>
      </div>

      <!-- Earnings & Deductions — single 4-column table -->
      <div class="ss-earn-ded">
        <table class="ss-ed-table">
          <colgroup>
            <col class="ss-ed-col-el">
            <col class="ss-ed-col-ea">
            <col class="ss-ed-col-dl">
            <col class="ss-ed-col-da">
          </colgroup>
          <thead>
            <tr>
              <th colspan="2" class="ss-th-earn">EARNINGS</th>
              <th colspan="2" class="ss-th-ded">DEDUCTIONS</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Basic Salary</td>           <td class="ss-ea">${fmtAmt(r.basic)}</td>           <td class="ss-dl">PF Contribution</td> <td class="ss-da">${fmtDed(r.pfContribution)}</td></tr>
            <tr><td>Dearness Allow. (DA)</td>   <td class="ss-ea">${fmtAmt(r.da)}</td>              <td class="ss-dl">Profession Tax</td>   <td class="ss-da">${fmtDed(r.professionTax)}</td></tr>
            <tr><td>House Rent Allow. (HRA)</td><td class="ss-ea">${fmtAmt(r.hra)}</td>             <td class="ss-dl">TDS</td>              <td class="ss-da">${fmtDed(r.tds)}</td></tr>
            <tr><td>Conveyance</td>             <td class="ss-ea">${fmtAmt(cw)}</td>                <td class="ss-dl">Salary Advance</td>   <td class="ss-da">${fmtDed(r.salaryAdvance)}</td></tr>
            <tr><td>Medical Expenses</td>       <td class="ss-ea">${fmtAmt(r.medicalExpenses)}</td> <td class="ss-dl"></td>                 <td class="ss-da"></td></tr>
            <tr><td>Special Allowance</td>      <td class="ss-ea">${fmtAmt(r.special)}</td>         <td class="ss-dl"></td>                 <td class="ss-da"></td></tr>
            <tr><td>Bonus</td>                  <td class="ss-ea">${fmtAmt(r.bonus)}</td>           <td class="ss-dl"></td>                 <td class="ss-da"></td></tr>
            <tr><td>Travel Allow. (TA)</td>     <td class="ss-ea">${fmtAmt(r.ta)}</td>              <td class="ss-dl"></td>                 <td class="ss-da"></td></tr>
          </tbody>
          <tfoot>
            <tr>
              <td class="ss-ed-ft-el"><strong>Gross Salary</strong></td>
              <td class="ss-ed-ft-ea"><strong>${fmtAmt(tg)}</strong></td>
              <td class="ss-ed-ft-dl"><strong>Total Deductions</strong></td>
              <td class="ss-ed-ft-da"><strong>${fmtDed(td)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- NET PAY Bar -->
      <div class="ss-netpay-bar">
        <span class="ss-netpay-label" style="color:#fff!important;">NET PAY</span>
        <span class="ss-netpay-val" style="color:#fff!important;font-size:22px;font-weight:900;">₹ ${np.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
      </div>

      <!-- Amount in Words -->
      <div class="ss-words-row">${numberToWords(np)}</div>

      <!-- Footer -->
      <div class="ss-footer">
        <div class="ss-footer-left">
          <div style="color:#9ca3af;font-size:11px;">Generated on ${genDate}</div>
          <div style="color:#9ca3af;font-size:10px;font-style:italic;">This is a computer-generated document.</div>
        </div>
        <div class="ss-footer-right">
          <div style="font-size:12px;color:#6b7280;">Authorized by</div>
          <div style="font-size:14px;font-weight:700;color:#111827;margin-top:2px;">${r.authorizedSignatory || 'Admin'}</div>
        </div>
      </div>
    </div>`;
  }

  printSlip() {
    const slip = document.getElementById('printable-slip');
    if (!slip) { alert('Select an employee first.'); return; }
    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>Salary Slip</title>
      <style>
        body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;margin:16px;color:#111827;}
        .salary-slip{max-width:780px;margin:0 auto;border:1px solid #999;}
        .ss-company-header{text-align:center;padding:18px 20px 12px;border-bottom:2px solid #111;}
        .ss-co-name{font-size:22px;font-weight:900;}
        .ss-co-addr,.ss-co-contact{font-size:10px;color:#555;margin-top:3px;}
        .ss-title-bar{text-align:center;padding:12px 20px 8px;}
        .ss-title{font-size:16px;font-weight:800;letter-spacing:0.08em;}
        .ss-subtitle{font-size:11px;color:#92400e;font-weight:600;margin-top:2px;}
        .ss-emp-grid{padding:4px 20px 8px;}
        .ss-emp-row{display:grid;grid-template-columns:110px 1fr 110px 1fr;gap:2px 6px;padding:2px 0;font-size:11px;border-bottom:1px solid #eee;}
        .ss-label{color:#666;font-weight:500;}
        .ss-value{color:#111;font-weight:700;}
        .ss-att-boxes{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:8px 20px;}
        .ss-att-box{border:1px solid #999;padding:6px 8px;}
        .ss-att-label{font-size:9px;color:#666;font-weight:600;text-transform:uppercase;}
        .ss-att-val{font-size:18px;font-weight:800;}
        .ss-earn-ded{padding:0 20px 10px;}
        .ss-ed-table{border-collapse:collapse;width:100%;font-size:11px;table-layout:fixed;}
        .ss-ed-col-el{width:auto;}.ss-ed-col-ea{width:100px;}.ss-ed-col-dl{width:auto;}.ss-ed-col-da{width:100px;}
        .ss-ed-table td{padding:4px 8px;border-bottom:1px solid #ddd;color:#111;}
        .ss-th-earn{background:#fef3c7;color:#92400e;font-weight:800;text-align:left;padding:6px 8px;border-bottom:2px solid #f59e0b;border-right:2px solid #e5e7eb;}
        .ss-th-ded{background:#fee2e2;color:#991b1b;font-weight:800;text-align:left;padding:6px 8px 6px 12px;border-bottom:2px solid #ef4444;}
        .ss-ea{text-align:right;font-weight:600;color:#111;white-space:nowrap;border-right:2px solid #e5e7eb;}
        .ss-dl{padding-left:12px;}
        .ss-da{text-align:right;font-weight:600;color:#dc2626;white-space:nowrap;}
        .ss-ed-ft-el{background:#fef9c3;border-top:2px solid #f59e0b;font-weight:700;padding:6px 8px;}
        .ss-ed-ft-ea{background:#fef9c3;border-top:2px solid #f59e0b;font-weight:700;text-align:right;white-space:nowrap;border-right:2px solid #e5e7eb;}
        .ss-ed-ft-dl{background:#fee2e2;border-top:2px solid #ef4444;font-weight:700;padding:6px 8px 6px 12px;}
        .ss-ed-ft-da{background:#fee2e2;border-top:2px solid #ef4444;font-weight:700;text-align:right;white-space:nowrap;color:#dc2626;}
        .ss-netpay-bar{display:flex;justify-content:space-between;align-items:center;background:#111;color:#fff;padding:12px 20px;margin:0 20px;}
        .ss-netpay-label{font-size:14px;font-weight:800;letter-spacing:0.06em;}
        .ss-netpay-val{font-size:20px;font-weight:900;}
        .ss-words-row{padding:6px 20px;font-size:10px;color:#666;font-style:italic;border-bottom:1px solid #ddd;}
        .ss-footer{display:flex;justify-content:space-between;align-items:flex-end;padding:12px 20px 16px;font-size:11px;}
        @media print{body{margin:0;}.salary-slip{border:none;box-shadow:none;}}
      </style></head><body>${slip.outerHTML}</body></html>`);
    w.document.close();
    w.print();
  }

  printConsolidation() {
    const tbl = document.getElementById('cons-print-table');
    if (!tbl) { alert('Nothing to print.'); return; }
    const bottom = document.querySelector('.cons-bottom');
    const fm = document.getElementById('cons-filter-month')?.value||'';
    const fy = document.getElementById('cons-filter-year')?.value||'';
    const w = window.open('', '_blank');
    w.document.write(`<!DOCTYPE html><html><head><title>Consolidated Salary Sheet</title>
      <style>
        body{font-family:Arial,sans-serif;font-size:10px;margin:12px;}
        h2{text-align:center;font-size:13px;margin-bottom:8px;}
        table{border-collapse:collapse;width:100%;}
        td,th{border:1px solid #999;padding:3px 4px;font-size:9px;}
        .hdr-gross{background:#e8f4e8;font-weight:700;text-align:center;}
        .hdr-ded{background:#fee2e2;font-weight:700;text-align:center;}
        .hdr-net{background:#dbeafe;font-weight:700;text-align:center;}
        .hdr-plain{background:#f3f4f6;font-weight:700;text-align:center;}
        .num{text-align:right;}
        .net-val{background:#dbeafe;font-weight:700;}
        .cons-total-row td{background:#1e3a8a;color:#fff;font-weight:700;}
        .cons-bottom{display:flex;justify-content:space-between;margin-top:12px;font-size:10px;}
        .cons-words{font-weight:700;}
        .sign-blank{margin-top:20px;}
      </style></head><body>
      <h2>Consolidated Salary Sheet for the month of ${fm||'All'} ${fy||''}</h2>
      ${tbl.outerHTML}
      ${bottom ? bottom.outerHTML : ''}
      </body></html>`);
    w.document.close();
    w.print();
  }

  // ── Save / Load ──────────────────────────────────────────────────────────
  _scheduleSave() {
    this._setStatus('unsaved');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this._saveNow(), 2000);
  }

  async _saveNow() {
    this._setStatus('saving');
    const payload = {
      name: this.wbName,
      sheetsData: [{ name: 'payroll', cells: this.rows }],
      activeSheet: 'payroll',
    };
    try {
      const token = typeof getToken === 'function' ? getToken() : localStorage.getItem('ems_token');
      if (!token) {
        this._setStatus('error');
        toast('Not logged in. Please log in first.', 'error');
        return;
      }
      const method = this.wbId ? 'PUT' : 'POST';
      const url    = this.wbId ? `/spreadsheet/${this.wbId}` : '/spreadsheet';
      const res    = await api(method, url, payload);
      if (!this.wbId && res && res.id) {
        this.wbId = res.id;
        history.replaceState(null, '', `?wb=${res.id}`);
      }
      this._setStatus('saved');
      toast('Payroll data saved successfully!', 'success');
    } catch(e) {
      console.error('Save error:', e);
      this._setStatus('error');
      toast('Failed to save: ' + (e.message || 'Unknown error'), 'error');
    }
  }

  async _loadData() {
    const params = new URLSearchParams(location.search);
    const wbId = params.get('wb');
    try {
      let data = null;
      if (wbId) {
        data = await api('GET', `/spreadsheet/${wbId}`);
      } else {
        const list = await api('GET', '/spreadsheet');
        if (list.length > 0) {
          data = await api('GET', `/spreadsheet/${list[0].id}`);
          history.replaceState(null, '', `?wb=${data.id}`);
        }
      }
      if (data) {
        this.wbId  = data.id;
        this.wbName = data.name;
        const sd = Array.isArray(data.sheetsData) ? data.sheetsData : [];
        const ps = sd.find(s => s.name === 'payroll');
        if (ps?.cells?.length) {
          this.rows = ps.cells.filter(r => r.name && r.name.trim());
          this._nextId = this.rows.length
            ? Math.max(...this.rows.map(r => r.id||0)) + 1
            : 1;
          this.renderDB();
        }
        this._setStatus('saved');
      }
    } catch(e) { /* first visit */ }
  }

  _setStatus(s) {
    this.saveStatus = s;
    const el = document.getElementById('save-status');
    if (!el) return;
    const map = {
      saved:   ['✓ Saved',   'status-saved'],
      unsaved: ['● Unsaved', 'status-unsaved'],
      saving:  ['⟳ Saving…','status-saving'],
      error:   ['✕ Error',   'status-error'],
    };
    const [text, cls] = map[s] || map.saved;
    el.textContent = text;
    el.className = 'save-status ' + cls;
  }
}

const payroll = new PayrollApp();
