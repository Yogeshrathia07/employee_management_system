const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');
const { Document, User, Client } = require('../models');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'documents');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const TYPE_CATEGORY = {
  aadhaar: 'identity', pan_card: 'identity', passport: 'identity',
  voter_id: 'identity', driving_license: 'identity',
  bank_passbook: 'financial', payslip: 'financial', salary_slip_past: 'financial',
  address_proof: 'address',
  degree_certificate: 'education', marksheet: 'education',
  experience_certificate: 'employment', experience_letter: 'employment',
  offer_letter: 'employment', joining_letter: 'employment', resume: 'employment',
  appointment_letter: 'employment', employment_contract: 'employment', hr_document: 'hr',
  technical_certification: 'certification',
  character_certificate: 'character',
  medical_document: 'medical',
  temporary_document: 'temporary',
  photo: 'other', other: 'other',
};

function sameId(a, b) {
  return Number(a) === Number(b);
}

function boolInput(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 'true' || value === '1' || value === 1 || value === 'on';
}

function cleanDate(value) {
  const v = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function isAdminActor(actor) {
  return actor.role === 'admin' || actor.role === 'superadmin';
}

function discardUploadedFile(req) {
  if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
}

function requestError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// An offer letter issued from a client record must remain within the same
// company boundary as both the signed-in administrator and selected employee.
async function resolveIssuingClient(actor, clientId, targetUser) {
  if (!clientId) return null;
  const id = Number(clientId);
  if (!Number.isInteger(id) || id <= 0) throw requestError('Select a valid issuing client');

  const client = await Client.findByPk(id, {
    attributes: ['id', 'name', 'clientCode', 'companyId'],
  });
  if (!client) throw requestError('Issuing client not found', 404);
  if (actor.role === 'admin' && (!actor.companyId || !sameId(actor.companyId, client.companyId))) {
    throw requestError('Access denied: client is outside your company', 403);
  }
  if (!targetUser.companyId || !client.companyId || !sameId(targetUser.companyId, client.companyId)) {
    throw requestError('The issuing client and employee must belong to the same company');
  }
  return client;
}

// Company-issued HR documents: only HR (admin/superadmin) and the employee
// they were issued to, and the employee only as far as the permission allows.
function hrDocumentAccessError(actor, doc, action) {
  if (!doc.issuedByCompany || isAdminActor(actor)) return null;
  if (!sameId(actor.id, doc.userId)) return 'This HR document is visible only to the employee and HR';
  if (doc.employeeCanView === false) return 'This document has not been shared with you yet';
  if (action === 'download' && doc.employeeCanDownload === false) {
    return 'Your employer allows viewing this document but not downloading it';
  }
  return null;
}

async function getAccessibleUser(actor, targetUserId) {
  const user = await User.findByPk(targetUserId, {
    attributes: ['id', 'companyId', 'managerId', 'role'],
  });
  if (!user) return null;

  if (actor.role === 'superadmin') return user;
  if (actor.role === 'employee') {
    return sameId(actor.id, user.id) ? user : null;
  }
  if (actor.role === 'manager') {
    return sameId(actor.id, user.id) || sameId(user.managerId, actor.id) ? user : null;
  }
  if (actor.role === 'admin') {
    return actor.companyId && sameId(actor.companyId, user.companyId) ? user : null;
  }
  return null;
}

async function ensureUserAccess(actor, targetUserId, res, message) {
  const user = await getAccessibleUser(actor, targetUserId);
  if (!user) {
    res.status(403).json({ message: message || 'Access denied' });
    return null;
  }
  return user;
}

exports.getDocuments = async (req, res) => {
  try {
    const { role, id, companyId } = req.user;
    const where = {};

    if (role === 'employee') {
      where.userId = id;
      where[Op.or] = [{ issuedByCompany: { [Op.not]: true } }, { employeeCanView: { [Op.not]: false } }];
    } else if (role === 'manager') {
      if (req.query.scope === 'team') {
        const teamUsers = await User.findAll({ where: { managerId: id }, attributes: ['id'] });
        where.userId = { [Op.in]: teamUsers.map((u) => u.id) };
        where.issuedByCompany = { [Op.not]: true };
      } else {
        where.userId = id;
        where[Op.or] = [{ issuedByCompany: { [Op.not]: true } }, { employeeCanView: { [Op.not]: false } }];
      }
    } else if (role === 'admin') {
      if (req.query.userId) {
        const targetUser = await ensureUserAccess(req.user, req.query.userId, res, 'Access denied: employee is outside your company');
        if (!targetUser) return;
        where.userId = targetUser.id;
      } else {
        const companyUsers = await User.findAll({ where: { companyId }, attributes: ['id'] });
        where.userId = { [Op.in]: companyUsers.map((u) => u.id) };
      }
    }

    if (role === 'superadmin' && req.query.companyId) where.companyId = req.query.companyId;
    if (role === 'superadmin' && req.query.userId) where.userId = req.query.userId;
    if (req.query.type) where.type = req.query.type;
    if (req.query.clientId) where.clientId = req.query.clientId;

    const docs = await Document.findAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'employeeCode'] },
        { model: User, as: 'uploader', attributes: ['id', 'name'] },
        { model: User, as: 'verifier', attributes: ['id', 'name'] },
        { model: Client, as: 'issuingClient', attributes: ['id', 'name', 'clientCode'], required: false },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json(docs);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.uploadDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const { title, type, userId, notes, degreeLabel, genuineConsent, clientId } = req.body;

    if ((req.user.role === 'employee' || req.user.role === 'manager') && genuineConsent !== 'true' && genuineConsent !== true) {
      discardUploadedFile(req);
      return res.status(400).json({ message: 'You must certify that the document is genuine before uploading.' });
    }

    const targetUserId = (req.user.role === 'admin' || req.user.role === 'superadmin') && userId
      ? userId
      : req.user.id;

    const targetUser = await ensureUserAccess(req.user, targetUserId, res, 'Access denied: you cannot upload a document for this user');
    if (!targetUser) { discardUploadedFile(req); return; }

    const docType = type || 'other';
    const isHrIssued = Document.HR_ISSUED_TYPES.includes(docType);
    if (isHrIssued && !isAdminActor(req.user)) {
      discardUploadedFile(req);
      return res.status(400).json({ message: 'Offer letters and other HR documents are issued by the company (admin) and appear in your profile automatically.' });
    }
    if (isHrIssued && sameId(targetUserId, req.user.id)) {
      discardUploadedFile(req);
      return res.status(400).json({ message: 'Select the employee this document is issued to.' });
    }
    if (clientId && docType !== 'offer_letter') {
      discardUploadedFile(req);
      return res.status(400).json({ message: 'A client can be linked only to an offer letter' });
    }
    let issuingClient;
    try {
      issuingClient = await resolveIssuingClient(req.user, clientId, targetUser);
    } catch (err) {
      discardUploadedFile(req);
      return res.status(err.status || 400).json({ message: err.message });
    }
    const category = TYPE_CATEGORY[docType] || 'other';
    const isMandatory = Document.MANDATORY_TYPES.includes(docType);
    const maxAllowed = Document.getMaxForType(docType);
    const existingCount = await Document.count({ where: { userId: targetUserId, type: docType } });

    if (existingCount >= maxAllowed) {
      discardUploadedFile(req);
      return res.status(400).json({ message: `Maximum ${maxAllowed} document(s) allowed for this type.` });
    }

    const doc = await Document.create({
      userId: targetUserId,
      companyId: targetUser.companyId || req.user.companyId || null,
      clientId: issuingClient ? issuingClient.id : null,
      title: title || req.file.originalname,
      type: docType,
      category,
      isMandatory,
      genuineConsent: genuineConsent === 'true' || genuineConsent === true,
      degreeLabel: degreeLabel || '',
      fileName: req.file.originalname,
      filePath: req.file.filename,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      uploadedBy: req.user.id,
      notes: notes || '',
      verificationStatus: isHrIssued ? 'verified' : 'pending',
      verifiedBy: isHrIssued ? req.user.id : null,
      verifiedAt: isHrIssued ? new Date() : null,
      issuedByCompany: isHrIssued,
      employeeCanView: isHrIssued ? boolInput(req.body.employeeCanView, true) : true,
      employeeCanDownload: isHrIssued ? boolInput(req.body.employeeCanDownload, true) : true,
      issueDate: cleanDate(req.body.issueDate),
    });

    if (isMandatory) await _checkAndUpdateVerificationStatus(targetUserId);

    const populated = await Document.findByPk(doc.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] },
        { model: User, as: 'uploader', attributes: ['id', 'name'] },
        { model: Client, as: 'issuingClient', attributes: ['id', 'name', 'clientCode'], required: false },
      ],
    });
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.verifyDocument = async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    const targetUser = await ensureUserAccess(req.user, doc.userId, res, 'Access denied: you cannot verify this document');
    if (!targetUser) return;
    if (req.user.role === 'manager' && sameId(req.user.id, targetUser.id)) {
      return res.status(403).json({ message: 'Managers cannot verify their own documents' });
    }

    const { status, note } = req.body;
    if (!['verified', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be verified or rejected' });
    }

    doc.verificationStatus = status;
    doc.verifiedBy = req.user.id;
    doc.verifiedAt = new Date();
    doc.verificationNote = note || '';
    await doc.save();

    if (Document.MANDATORY_TYPES.includes(doc.type)) await _checkAndUpdateVerificationStatus(doc.userId);

    const populated = await Document.findByPk(doc.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] },
        { model: User, as: 'verifier', attributes: ['id', 'name'] },
      ],
    });
    res.json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getMandatoryDocStatus = async (req, res) => {
  try {
    const userId = req.params.userId;
    const targetUser = await ensureUserAccess(req.user, userId, res, 'Access denied: you cannot view mandatory document status for this user');
    if (!targetUser) return;
    const mandatory = Document.MANDATORY_TYPES;
    const uploaded = await Document.findAll({ where: { userId: targetUser.id, type: mandatory } });
    const uploadedTypes = uploaded.map((d) => d.type);

    const status = mandatory.map((type) => ({
      type,
      uploaded: uploadedTypes.includes(type),
      doc: uploaded.find((d) => d.type === type) || null,
    }));

    res.json(status);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.downloadDocument = async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    const targetUser = await ensureUserAccess(req.user, doc.userId, res, 'Access denied');
    if (!targetUser) return;
    const denied = hrDocumentAccessError(req.user, doc, 'download');
    if (denied) return res.status(403).json({ message: denied });

    const filePath = path.join(UPLOAD_DIR, doc.filePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found on server' });
    res.download(filePath, doc.fileName);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.viewDocument = async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    const targetUser = await ensureUserAccess(req.user, doc.userId, res, 'Access denied');
    if (!targetUser) return;
    const denied = hrDocumentAccessError(req.user, doc, 'view');
    if (denied) return res.status(403).json({ message: denied });

    const filePath = path.join(UPLOAD_DIR, doc.filePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found on server' });

    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteDocument = async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    const targetUser = await ensureUserAccess(req.user, doc.userId, res, 'Access denied: this document does not belong to an accessible user');
    if (!targetUser) return;
    if (req.user.role === 'manager' && !sameId(req.user.id, targetUser.id)) {
      return res.status(403).json({ message: 'Managers can delete only their own documents' });
    }
    if (doc.issuedByCompany && !isAdminActor(req.user)) {
      return res.status(403).json({ message: 'Documents issued by the company can only be removed by HR / admin' });
    }

    const filePath = path.join(UPLOAD_DIR, doc.filePath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await doc.destroy();
    if (Document.MANDATORY_TYPES.includes(doc.type)) await _checkAndUpdateVerificationStatus(doc.userId);
    res.json({ message: 'Document deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PUT /documents/:id/file — admin/superadmin replaces the file of a document
// (e.g. a revised offer letter). The record, its link to the employee and its
// permissions stay the same; the version number goes up.
exports.replaceDocumentFile = async (req, res) => {
  const discardUpload = () => { if (req.file) fs.unlink(req.file.path, () => {}); };
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    const doc = await Document.findByPk(req.params.id);
    if (!doc) { discardUpload(); return res.status(404).json({ message: 'Document not found' }); }
    const targetUser = await getAccessibleUser(req.user, doc.userId);
    if (!targetUser) { discardUpload(); return res.status(403).json({ message: 'Access denied: employee is outside your company' }); }

    const oldFile = doc.filePath;
    doc.fileName = req.file.originalname;
    doc.filePath = req.file.filename;
    doc.fileSize = req.file.size;
    doc.mimeType = req.file.mimetype;
    doc.uploadedBy = req.user.id;
    doc.version = (Number(doc.version) || 1) + 1;
    doc.replacedAt = new Date();
    if (req.body.title) doc.title = String(req.body.title).trim();
    if (req.body.notes !== undefined) doc.notes = req.body.notes;
    if (req.body.issueDate !== undefined) doc.issueDate = cleanDate(req.body.issueDate);
    if (doc.issuedByCompany) {
      doc.employeeCanView = boolInput(req.body.employeeCanView, doc.employeeCanView !== false);
      doc.employeeCanDownload = boolInput(req.body.employeeCanDownload, doc.employeeCanDownload !== false);
    }
    await doc.save();

    if (oldFile && oldFile !== doc.filePath) {
      fs.unlink(path.join(UPLOAD_DIR, oldFile), () => {});
    }
    const populated = await Document.findByPk(doc.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'employeeCode'] },
        { model: User, as: 'uploader', attributes: ['id', 'name'] },
        { model: Client, as: 'issuingClient', attributes: ['id', 'name', 'clientCode'], required: false },
      ],
    });
    res.json(populated);
  } catch (err) {
    discardUpload();
    res.status(500).json({ message: err.message });
  }
};

// PATCH /documents/:id — admin/superadmin updates details and employee access
exports.updateDocumentDetails = async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });
    const targetUser = await ensureUserAccess(req.user, doc.userId, res, 'Access denied: employee is outside your company');
    if (!targetUser) return;
    if (req.body.title !== undefined && String(req.body.title).trim()) doc.title = String(req.body.title).trim();
    if (req.body.notes !== undefined) doc.notes = req.body.notes || '';
    if (req.body.issueDate !== undefined) doc.issueDate = cleanDate(req.body.issueDate);
    if (req.body.employeeCanView !== undefined) doc.employeeCanView = boolInput(req.body.employeeCanView, true);
    if (req.body.employeeCanDownload !== undefined) doc.employeeCanDownload = boolInput(req.body.employeeCanDownload, true);
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Employee verification depends only on the mandatory documents, so callers run
// this only when one of those changes (an offer letter must not re-lock a
// verified employee).
async function _checkAndUpdateVerificationStatus(userId) {
  try {
    const user = await User.findByPk(userId);
    if (!user || user.role !== 'employee') return;

    const mandatory = Document.MANDATORY_TYPES;
    const docs = await Document.findAll({ where: { userId, type: mandatory } });
    const docsByType = new Map();

    docs.forEach((doc) => {
      if (!docsByType.has(doc.type)) docsByType.set(doc.type, []);
      docsByType.get(doc.type).push(doc);
    });

    const allUploaded = mandatory.every((type) => docsByType.has(type) && docsByType.get(type).length > 0);
    let nextStatus = 'pending_docs';

    if (allUploaded) {
      const hasRejected = mandatory.some((type) =>
        docsByType.get(type).some((doc) => doc.verificationStatus === 'rejected')
      );
      const allVerified = mandatory.every((type) =>
        docsByType.get(type).some((doc) => doc.verificationStatus === 'verified')
      );

      if (allVerified) nextStatus = 'verified';
      else if (hasRejected) nextStatus = 'pending_docs';
      else nextStatus = 'docs_submitted';
    }

    if (user.verificationStatus !== nextStatus) {
      user.verificationStatus = nextStatus;
      if (nextStatus === 'verified') user.status = 'active';
      await user.save();
    }
  } catch (_) {}
}
