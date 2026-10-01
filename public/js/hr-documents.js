/* ═══════════════════════════════════════════════════════════════════════════
   Employee document sections — shared by the server (models/Document.js) and
   the pages that show an employee's documents (Profile → Documents, Employees
   → View, Documents). Company-issued HR documents (offer letter, appointment
   letter, employment contract…) are uploaded by the admin / client side and
   shown read-only to the employee according to the view/download permission.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HRDocs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HR_ISSUED_TYPES = ['offer_letter', 'appointment_letter', 'employment_contract', 'joining_letter', 'hr_document'];

  var TYPE_LABELS = {
    aadhaar: 'Aadhaar Card', pan_card: 'PAN Card', passport: 'Passport', voter_id: 'Voter ID',
    driving_license: 'Driving License', address_proof: 'Address Proof',
    offer_letter: 'Offer Letter', appointment_letter: 'Appointment Letter', joining_letter: 'Joining Letter',
    employment_contract: 'Employment Contract', hr_document: 'HR Document',
    degree_certificate: 'Degree Certificate', marksheet: 'Marksheet', technical_certification: 'Technical Certification',
    experience_certificate: 'Experience Certificate', experience_letter: 'Experience Letter',
    character_certificate: 'Character Certificate', bank_passbook: 'Bank Passbook',
    medical_document: 'Medical Document', payslip: 'Payslip', salary_slip_past: 'Previous Salary Slip',
    resume: 'Resume', photo: 'Passport Photo', temporary_document: 'Temporary Document', other: 'Other',
  };

  var PROFILE_SECTIONS = [
    { key: 'id_proof',            label: 'ID Proof',            icon: 'bxs-id-card',      types: ['aadhaar', 'pan_card', 'passport', 'voter_id', 'driving_license'] },
    { key: 'address_proof',       label: 'Address Proof',       icon: 'bxs-home',         types: ['address_proof'] },
    { key: 'offer_letter',        label: 'Offer Letter',        icon: 'bxs-envelope',     types: ['offer_letter'], issued: true },
    { key: 'appointment_letter',  label: 'Appointment Letter',  icon: 'bxs-file-doc',     types: ['appointment_letter', 'joining_letter'], issued: true },
    { key: 'employment_contract', label: 'Employment Contract', icon: 'bxs-file-blank',   types: ['employment_contract'], issued: true },
    { key: 'certificates',        label: 'Certificates',        icon: 'bxs-graduation',   types: ['degree_certificate', 'marksheet', 'technical_certification', 'experience_certificate', 'experience_letter', 'character_certificate'] },
    { key: 'other_hr',            label: 'Other HR Documents',  icon: 'bxs-folder',       types: ['hr_document', 'payslip', 'salary_slip_past', 'bank_passbook', 'medical_document', 'resume', 'photo', 'temporary_document', 'other'] },
  ];

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function typeLabel(type) {
    return TYPE_LABELS[type] || String(type || 'Other').replace(/_/g, ' ');
  }

  function sectionForType(type) {
    for (var i = 0; i < PROFILE_SECTIONS.length; i++) {
      if (PROFILE_SECTIONS[i].types.indexOf(type) !== -1) return PROFILE_SECTIONS[i];
    }
    return PROFILE_SECTIONS[PROFILE_SECTIONS.length - 1];
  }

  function isIssuedType(type) {
    return HR_ISSUED_TYPES.indexOf(type) !== -1;
  }

  function fmtDate(value) {
    if (!value) return '—';
    var d = new Date(String(value).length === 10 ? value + 'T00:00:00' : value);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fileSize(bytes) {
    var b = Number(bytes || 0);
    return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  }

  /* Render the document sections as HTML.
     options.mode    'admin' (can upload / replace / set permissions / delete) or 'employee'
     options.actions names of global functions: view, download, verify, replace, permissions, remove, upload */
  function renderSections(docs, options) {
    options = options || {};
    var admin = options.mode === 'admin';
    var act = options.actions || {};
    docs = (docs || []).slice().sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });

    return '<div class="hrdoc-grid">' + PROFILE_SECTIONS.map(function (section) {
      var list = docs.filter(function (d) { return sectionForType(d.type).key === section.key; });
      var head = '<div class="hrdoc-head">' +
          '<div class="hrdoc-title"><i class="bx ' + section.icon + '"></i>' + esc(section.label) +
            (section.issued ? '<span class="hrdoc-issued-tag">Issued by company</span>' : '') + '</div>' +
          '<span class="hrdoc-count">' + list.length + '</span>' +
        '</div>';
      var uploadBtn = admin && section.issued && act.upload
        ? '<button type="button" class="btn btn-ghost btn-sm" onclick="' + act.upload + '(\'' + section.types[0] + '\')"><i class="bx bx-upload"></i> Upload ' + esc(section.label) + '</button>'
        : '';
      if (!list.length) {
        return '<div class="hrdoc-card">' + head +
          '<div class="hrdoc-empty">' + (section.issued && !admin ? 'Not issued yet.' : 'No document uploaded.') + '</div>' +
          (uploadBtn ? '<div class="hrdoc-actions">' + uploadBtn + '</div>' : '') +
        '</div>';
      }
      return '<div class="hrdoc-card">' + head + list.map(function (d) {
        var issued = !!d.issuedByCompany;
        var canView = admin || !issued || d.employeeCanView !== false;
        var canDownload = admin || !issued || d.employeeCanDownload !== false;
        var status = d.verificationStatus || 'pending';
        var badge = issued
          ? '<span class="hrdoc-badge hrdoc-badge-issued">Issued</span>'
          : '<span class="hrdoc-badge hrdoc-badge-' + esc(status) + '">' + esc(status) + '</span>';
        var permissionLine = issued && admin
          ? '<div class="hrdoc-perm"><i class="bx bx-lock-open-alt"></i> Employee: ' +
              (d.employeeCanView === false ? 'hidden' : 'can view') +
              (d.employeeCanView !== false ? (d.employeeCanDownload === false ? ', no download' : ', can download') : '') + '</div>'
          : '';
        var buttons = [];
        if (canView && act.view) buttons.push('<button type="button" class="btn btn-ghost btn-sm" onclick="' + act.view + '(' + d.id + ')" title="View"><i class="bx bx-show"></i> View</button>');
        if (canDownload && act.download) buttons.push('<button type="button" class="btn btn-ghost btn-sm" onclick="' + act.download + '(' + d.id + ')" title="Download"><i class="bx bx-download"></i> Download</button>');
        if (admin && !issued && act.verify) buttons.push('<button type="button" class="btn btn-ghost btn-sm" onclick="' + act.verify + '(' + d.id + ')" title="Verify"><i class="bx bx-check-shield"></i> Verify</button>');
        if (admin && issued && act.replace) buttons.push('<button type="button" class="btn btn-ghost btn-sm" onclick="' + act.replace + '(' + d.id + ')" title="Replace file"><i class="bx bx-transfer-alt"></i> Replace</button>');
        if (admin && issued && act.permissions) buttons.push('<button type="button" class="btn btn-ghost btn-sm" onclick="' + act.permissions + '(' + d.id + ')" title="Employee access"><i class="bx bx-lock-alt"></i> Access</button>');
        if (admin && act.remove) buttons.push('<button type="button" class="btn btn-danger btn-sm" onclick="' + act.remove + '(' + d.id + ')" title="Delete"><i class="bx bx-trash"></i></button>');
        if (!admin && issued && !canDownload) buttons.push('<span class="hrdoc-note">Download not permitted</span>');
        return '<div class="hrdoc-item">' +
          '<div class="hrdoc-item-top"><div class="hrdoc-item-title">' + esc(d.title || typeLabel(d.type)) + '</div>' + badge + '</div>' +
          '<div class="hrdoc-meta">' + esc(typeLabel(d.type)) +
            (d.issueDate ? ' · Issued ' + fmtDate(d.issueDate) : '') +
            (d.issuingClient && d.issuingClient.name ? ' · Issued by client: ' + esc(d.issuingClient.name) : '') +
            ' · Uploaded ' + fmtDate(d.replacedAt || d.createdAt) +
            (d.uploader && d.uploader.name ? ' by ' + esc(d.uploader.name) : '') +
            (d.version > 1 ? ' · v' + d.version : '') +
            ' · ' + fileSize(d.fileSize) +
          '</div>' +
          (d.notes ? '<div class="hrdoc-notes">' + esc(d.notes) + '</div>' : '') +
          permissionLine +
          '<div class="hrdoc-actions">' + buttons.join('') + '</div>' +
        '</div>';
      }).join('') + (uploadBtn ? '<div class="hrdoc-actions">' + uploadBtn + '</div>' : '') + '</div>';
    }).join('') + '</div>';
  }

  var STYLES =
    '.hrdoc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}' +
    '.hrdoc-card{background:#fff;border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}' +
    '.hrdoc-head{display:flex;align-items:center;justify-content:space-between;gap:8px}' +
    '.hrdoc-title{display:flex;align-items:center;gap:6px;font-weight:700;font-size:13px;color:var(--text-primary,#111827);flex-wrap:wrap}' +
    '.hrdoc-title i{font-size:16px;color:var(--accent,#4f46e5)}' +
    '.hrdoc-issued-tag{font-size:10px;font-weight:700;color:#0f766e;background:#ccfbf1;border-radius:10px;padding:1px 7px}' +
    '.hrdoc-count{min-width:22px;height:22px;border-radius:11px;background:var(--bg-input,#f3f4f6);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--text-muted,#6b7280)}' +
    '.hrdoc-empty{font-size:12px;color:var(--text-muted,#9ca3af)}' +
    '.hrdoc-item{border-top:1px dashed var(--border,#e5e7eb);padding-top:8px}' +
    '.hrdoc-item-top{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}' +
    '.hrdoc-item-title{font-weight:700;font-size:12.5px;color:var(--text-primary,#111827);word-break:break-word}' +
    '.hrdoc-meta{font-size:11px;color:var(--text-muted,#6b7280);margin-top:2px;line-height:1.4}' +
    '.hrdoc-notes{font-size:11px;color:var(--text-secondary,#374151);margin-top:3px}' +
    '.hrdoc-perm{font-size:11px;color:#0f766e;margin-top:3px}' +
    '.hrdoc-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;align-items:center}' +
    '.hrdoc-note{font-size:11px;color:var(--text-muted,#9ca3af)}' +
    '.hrdoc-badge{font-size:10px;font-weight:700;border-radius:10px;padding:2px 8px;text-transform:capitalize;white-space:nowrap}' +
    '.hrdoc-badge-issued{background:#ccfbf1;color:#0f766e}' +
    '.hrdoc-badge-verified{background:#dcfce7;color:#16a34a}' +
    '.hrdoc-badge-rejected{background:#fee2e2;color:#dc2626}' +
    '.hrdoc-badge-pending{background:#fef3c7;color:#b45309}';

  function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById('hrdoc-styles')) return;
    var style = document.createElement('style');
    style.id = 'hrdoc-styles';
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  return {
    HR_ISSUED_TYPES: HR_ISSUED_TYPES,
    PROFILE_SECTIONS: PROFILE_SECTIONS,
    TYPE_LABELS: TYPE_LABELS,
    typeLabel: typeLabel,
    sectionForType: sectionForType,
    isIssuedType: isIssuedType,
    renderSections: renderSections,
    injectStyles: injectStyles,
  };
});
