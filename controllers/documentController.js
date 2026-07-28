const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');
const { Document, User } = require('../models');

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
  technical_certification: 'certification',
  character_certificate: 'character',
  medical_document: 'medical',
  temporary_document: 'temporary',
  photo: 'other', other: 'other',
};

function sameId(a, b) {
  return Number(a) === Number(b);
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
    } else if (role === 'manager') {
      if (req.query.scope === 'team') {
        const teamUsers = await User.findAll({ where: { managerId: id }, attributes: ['id'] });
        where.userId = { [Op.in]: teamUsers.map((u) => u.id) };
      } else {
        where.userId = id;
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

    const docs = await Document.findAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role', 'employeeCode'] },
        { model: User, as: 'uploader', attributes: ['id', 'name'] },
        { model: User, as: 'verifier', attributes: ['id', 'name'] },
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

    const { title, type, userId, notes, degreeLabel, genuineConsent } = req.body;

    if ((req.user.role === 'employee' || req.user.role === 'manager') && genuineConsent !== 'true' && genuineConsent !== true) {
      return res.status(400).json({ message: 'You must certify that the document is genuine before uploading.' });
    }

    const targetUserId = (req.user.role === 'admin' || req.user.role === 'superadmin') && userId
      ? userId
      : req.user.id;

    const targetUser = await ensureUserAccess(req.user, targetUserId, res, 'Access denied: you cannot upload a document for this user');
    if (!targetUser) return;

    const docType = type || 'other';
    const category = TYPE_CATEGORY[docType] || 'other';
    const isMandatory = Document.MANDATORY_TYPES.includes(docType);
    const maxAllowed = Document.getMaxForType(docType);
    const existingCount = await Document.count({ where: { userId: targetUserId, type: docType } });

    if (existingCount >= maxAllowed) {
      return res.status(400).json({ message: `Maximum ${maxAllowed} document(s) allowed for this type.` });
    }

    const doc = await Document.create({
      userId: targetUserId,
      companyId: targetUser.companyId || req.user.companyId || null,
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
      verificationStatus: 'pending',
    });

    await _checkAndUpdateVerificationStatus(targetUserId);

    const populated = await Document.findByPk(doc.id, {
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'role'] },
        { model: User, as: 'uploader', attributes: ['id', 'name'] },
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

    await _checkAndUpdateVerificationStatus(doc.userId);

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

    const filePath = path.join(UPLOAD_DIR, doc.filePath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await doc.destroy();
    await _checkAndUpdateVerificationStatus(doc.userId);
    res.json({ message: 'Document deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

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
