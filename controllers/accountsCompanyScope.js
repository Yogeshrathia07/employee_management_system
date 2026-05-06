'use strict';

const { Op } = require('sequelize');
const {
  Company,
  User,
  Vendor,
  Client,
  Quotation,
  Proforma,
  Invoice,
  PurchaseOrder,
  ProjectAccount,
  WorkOrder,
} = require('../models');

const SYNC_THROTTLE_MS = 2 * 60 * 1000;

let syncPromise = null;
let lastSyncAt = 0;

function getActorCompanyId(req) {
  const value = Number(req && req.user && req.user.companyId);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isAdminScoped(req) {
  return !!(req && req.user && req.user.role === 'admin');
}

function applyCompanyScope(req, where) {
  if (isAdminScoped(req)) {
    const scopedCompanyId = getActorCompanyId(req);
    where.companyId = scopedCompanyId || -1;
  }
  return where;
}

async function getRequestCompany(req) {
  const companyId = getActorCompanyId(req);
  if (!companyId) return null;
  return Company.findByPk(companyId);
}

async function findCompanyByName(name) {
  const normalized = String(name || '').trim();
  if (!normalized) return null;
  return Company.findOne({ where: { name: { [Op.like]: normalized } } });
}

async function resolveCompanyFromPayload(payload) {
  const companyId = Number(payload && payload.companyId);
  if (Number.isFinite(companyId) && companyId > 0) {
    const byId = await Company.findByPk(companyId);
    if (byId) return byId;
  }
  return findCompanyByName(payload && payload.sellerName);
}

async function resolveScopedCompany(req, payload) {
  if (isAdminScoped(req)) return getRequestCompany(req);
  return resolveCompanyFromPayload(payload);
}

function applySellerCompanySnapshot(target, company) {
  if (!target || !company) return target;
  target.companyId = company.id || null;
  target.sellerName = company.name || '';
  target.sellerAddress = company.address || '';
  target.sellerPhone = company.phone || '';
  target.sellerEmail = company.email || '';
  target.sellerGstin = company.gstNo || '';
  target.sellerPan = company.panNo || '';
  target.sellerState = company.state || '';
  target.sellerStateCode = company.stateCode || '';
  target.bankName = company.bankName || '';
  target.bankAcName = company.bankAcName || '';
  target.bankAccount = company.bankAccount || '';
  target.bankIfsc = company.bankIfsc || '';
  target.bankBranch = company.bankBranch || '';
  return target;
}

async function firstCompanyId(Model, where) {
  const row = await Model.findOne({
    where: Object.assign({}, where, {
      companyId: { [Op.ne]: null },
    }),
    attributes: ['companyId'],
    raw: true,
    order: [['updatedAt', 'DESC']],
  });
  const value = Number(row && row.companyId);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function inferCompanyId(label, record) {
  if (!record) return null;
  const companyId = Number(record.companyId || (record.company && record.company.id));
  if (Number.isFinite(companyId) && companyId > 0) return companyId;

  if (record.sellerName) {
    const sellerCompany = await findCompanyByName(record.sellerName);
    if (sellerCompany) return sellerCompany.id;
  }

  switch (label) {
    case 'quotation': {
      if (record.clientId) {
        const client = await Client.findByPk(record.clientId, { attributes: ['companyId'] });
        if (client && client.companyId) return client.companyId;
      }
      break;
    }
    case 'proforma': {
      if (record.sourceQuotationId) {
        const quotation = await Quotation.findByPk(record.sourceQuotationId, { attributes: ['companyId'] });
        if (quotation && quotation.companyId) return quotation.companyId;
      }
      if (record.clientId) {
        const client = await Client.findByPk(record.clientId, { attributes: ['companyId'] });
        if (client && client.companyId) return client.companyId;
      }
      break;
    }
    case 'invoice': {
      if (record.sourceDocId && record.sourceDocType === 'proforma') {
        const proforma = await Proforma.findByPk(record.sourceDocId, { attributes: ['companyId'] });
        if (proforma && proforma.companyId) return proforma.companyId;
      }
      if (record.sourceDocId && record.sourceDocType === 'quotation') {
        const quotation = await Quotation.findByPk(record.sourceDocId, { attributes: ['companyId'] });
        if (quotation && quotation.companyId) return quotation.companyId;
      }
      if (record.projectAccountId) {
        const projectAccount = await ProjectAccount.findByPk(record.projectAccountId, { attributes: ['companyId'] });
        if (projectAccount && projectAccount.companyId) return projectAccount.companyId;
      }
      if (record.clientId) {
        const client = await Client.findByPk(record.clientId, { attributes: ['companyId'] });
        if (client && client.companyId) return client.companyId;
      }
      if (record.vendorId) {
        const vendor = await Vendor.findByPk(record.vendorId, { attributes: ['companyId'] });
        if (vendor && vendor.companyId) return vendor.companyId;
      }
      break;
    }
    case 'purchaseOrder': {
      if (record.projectAccountId) {
        const projectAccount = await ProjectAccount.findByPk(record.projectAccountId, { attributes: ['companyId'] });
        if (projectAccount && projectAccount.companyId) return projectAccount.companyId;
      }
      if (record.vendorId) {
        const vendor = await Vendor.findByPk(record.vendorId, { attributes: ['companyId'] });
        if (vendor && vendor.companyId) return vendor.companyId;
      }
      break;
    }
    case 'projectAccount': {
      if (record.clientId) {
        const client = await Client.findByPk(record.clientId, { attributes: ['companyId'] });
        if (client && client.companyId) return client.companyId;
      }
      if (record.id) {
        const poCompanyId = await firstCompanyId(PurchaseOrder, { projectAccountId: record.id });
        if (poCompanyId) return poCompanyId;
        const invCompanyId = await firstCompanyId(Invoice, { projectAccountId: record.id });
        if (invCompanyId) return invCompanyId;
        const woCompanyId = await firstCompanyId(WorkOrder, { projectAccountId: record.id });
        if (woCompanyId) return woCompanyId;
      }
      break;
    }
    case 'workOrder': {
      if (record.projectAccountId) {
        const projectAccount = await ProjectAccount.findByPk(record.projectAccountId, { attributes: ['companyId'] });
        if (projectAccount && projectAccount.companyId) return projectAccount.companyId;
      }
      if (record.clientId) {
        const client = await Client.findByPk(record.clientId, { attributes: ['companyId'] });
        if (client && client.companyId) return client.companyId;
      }
      if (record.vendorId) {
        const vendor = await Vendor.findByPk(record.vendorId, { attributes: ['companyId'] });
        if (vendor && vendor.companyId) return vendor.companyId;
      }
      break;
    }
    case 'client': {
      if (record.id) {
        const quoteCompanyId = await firstCompanyId(Quotation, { clientId: record.id });
        if (quoteCompanyId) return quoteCompanyId;
        const proCompanyId = await firstCompanyId(Proforma, { clientId: record.id });
        if (proCompanyId) return proCompanyId;
        const invCompanyId = await firstCompanyId(Invoice, { clientId: record.id });
        if (invCompanyId) return invCompanyId;
        const woCompanyId = await firstCompanyId(WorkOrder, { clientId: record.id });
        if (woCompanyId) return woCompanyId;
        const projectCompanyId = await firstCompanyId(ProjectAccount, { clientId: record.id });
        if (projectCompanyId) return projectCompanyId;
      }
      break;
    }
    case 'vendor': {
      if (record.id) {
        const poCompanyId = await firstCompanyId(PurchaseOrder, { vendorId: record.id });
        if (poCompanyId) return poCompanyId;
        const woCompanyId = await firstCompanyId(WorkOrder, { vendorId: record.id });
        if (woCompanyId) return woCompanyId;
        const invCompanyId = await firstCompanyId(Invoice, { vendorId: record.id });
        if (invCompanyId) return invCompanyId;
      }
      break;
    }
    default:
      break;
  }

  if (record.createdBy) {
    const creator = await User.findByPk(record.createdBy, { attributes: ['companyId'] });
    if (creator && creator.companyId) return creator.companyId;
  }

  return null;
}

async function backfillModelCompanyIds(label, Model) {
  const rows = await Model.findAll({
    where: { companyId: null },
    order: [['updatedAt', 'DESC']],
    limit: 200,
  });

  for (const row of rows) {
    const companyId = await inferCompanyId(label, row.toJSON ? row.toJSON() : row);
    if (companyId) {
      await row.update({ companyId });
    }
  }
}

async function syncAccountsCompanyIds(force) {
  const now = Date.now();
  if (!force && syncPromise) return syncPromise;
  if (!force && lastSyncAt && now - lastSyncAt < SYNC_THROTTLE_MS) return;

  syncPromise = (async () => {
    await backfillModelCompanyIds('workOrder', WorkOrder);
    await backfillModelCompanyIds('quotation', Quotation);
    await backfillModelCompanyIds('proforma', Proforma);
    await backfillModelCompanyIds('invoice', Invoice);
    await backfillModelCompanyIds('projectAccount', ProjectAccount);
    await backfillModelCompanyIds('purchaseOrder', PurchaseOrder);
    await backfillModelCompanyIds('client', Client);
    await backfillModelCompanyIds('vendor', Vendor);
  })()
    .finally(() => {
      lastSyncAt = Date.now();
      syncPromise = null;
    });

  return syncPromise;
}

async function ensureCompanyAccess(req, label, record, missingMessage) {
  if (!record) {
    return { ok: false, status: 404, message: missingMessage || 'Record not found' };
  }

  let companyId = Number(record.companyId || (record.company && record.company.id));
  if (!Number.isFinite(companyId) || companyId <= 0) {
    companyId = await inferCompanyId(label, record.toJSON ? record.toJSON() : record);
    if (companyId && typeof record.update === 'function') {
      await record.update({ companyId });
    }
  }

  const scopedCompanyId = isAdminScoped(req) ? getActorCompanyId(req) : null;
  if (isAdminScoped(req) && (!scopedCompanyId || Number(companyId || 0) !== scopedCompanyId)) {
    return { ok: false, status: 404, message: missingMessage || 'Record not found' };
  }

  return { ok: true, companyId: companyId || null };
}

async function findScopedByPk(Model, label, req, id, options, missingMessage) {
  const record = await Model.findByPk(id, options);
  const access = await ensureCompanyAccess(req, label, record, missingMessage);
  return access.ok ? record : null;
}

async function assertScopedRelation(Model, label, req, id, missingMessage) {
  if (!id) return null;
  const record = await Model.findByPk(id);
  const access = await ensureCompanyAccess(req, label, record, missingMessage);
  if (!access.ok) {
    const err = new Error(access.message);
    err.status = access.status;
    throw err;
  }
  return record;
}

module.exports = {
  applyCompanyScope,
  applySellerCompanySnapshot,
  assertScopedRelation,
  ensureCompanyAccess,
  findScopedByPk,
  getActorCompanyId,
  getRequestCompany,
  isAdminScoped,
  resolveCompanyFromPayload,
  resolveScopedCompany,
  syncAccountsCompanyIds,
};
