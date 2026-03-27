const path = require('path');
const fs   = require('fs');
const { Op } = require('sequelize');
const { Document, User } = require('../models');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'documents');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Category mapping (extended)
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
  photo: 'other', other: 'other',
};

// ── GET /documents ────────────────────────────────────────────────────────────
exports.getDocuments = async (req, res) => {
  try {
    const { role, id, companyId } = req.user;
    let where = {};

    if (role === 'employee' || role === 'manager') {
      where.userId = req.query.userId || id;
    } else if (role === 'admin') {
      if (req.query.userId) {
        where.userId = req.query.userId;
      } else {
        const companyUsers = await User.findAll({ where: { companyId }, attributes: ['id'] });
        where.userId = { [Op.in]: companyUsers.map(u => u.id) };
      }
    }
    if (role === 'superadmin' && req.query.companyId) where.companyId = req.query.companyId;
    if (role === 'superadmin' && req.query.userId) where.userId = req.query.userId;
    if (req.query.type) where.type = req.query.type;

    const docs = await Document.findAll({
      where,
      include: [
        { model: User, as: 'user',     attributes: ['id', 'name', 'email', 'role', 'employeeCode'] },
        { model: User, as: 'uploader', attributes: ['id', 'name'] },
        { model: User, as: 'verifier', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json(docs);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /documents ───────────────────────────────────────────────────────────
exports.uploadDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const { title, type, userId, notes, degreeLabel, genuineConsent } = req.body;

    // Employees MUST tick consent
    if (req.user.role === 'employee' && genuineConsent !== 'true' && genuineConsent !== true) {
      return res.status(400).json({ message: 'You must certify that the document is genuine before uploading.' });
    }

    const targetUserId = (req.user.role === 'admin' || req.user.role === 'superadmin') && userId
      ? userId : req.user.id;

    const docType  = type || 'other';
    const category = TYPE_CATEGORY[docType] || 'other';
    const isMandatory = Document.MANDATORY_TYPES.includes(docType);

    // Enforce max per type
    const maxAllowed    = Document.getMaxForType(docType);
    const existingCount = await Document.count({ where: { userId: targetUserId, type: docType } });
    if (existingCount >= maxAllowed) {
      return res.status(400).json({ message: `Maximum ${maxAllowed} document(s) allowed for this type.` });
    }

    const doc = await Document.create({
      userId: targetUserId,
      companyId: req.user.companyId,
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

    // Check if all mandatory docs are now uploaded → update user verificationStatus
    await _checkAndUpdateVerificationStatus(targetUserId);

    const populated = await Document.findByPk(doc.id, {
      include: [
        { model: User, as: 'user',     attributes: ['id', 'name', 'email', 'role'] },
        { model: User, as: 'uploader', attributes: ['id', 'name'] },
      ],
    });
    res.status(201).json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PATCH /documents/:id/verify ───────────────────────────────────────────────
exports.verifyDocument = async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    const { status, note } = req.body; // status: 'verified' | 'rejected'
    if (!['verified', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Status must be verified or rejected' });
    }

    doc.verificationStatus = status;
    doc.verifiedBy   = req.user.id;
    doc.verifiedAt   = new Date();
    doc.verificationNote = note || '';
    await doc.save();

    // Also update the employee's overall verification status
    await _checkAndUpdateVerificationStatus(doc.userId);

    const populated = await Document.findByPk(doc.id, {
      include: [
        { model: User, as: 'user',     attributes: ['id', 'name', 'email', 'role'] },
        { model: User, as: 'verifier', attributes: ['id', 'name'] },
      ],
    });
    res.json(populated);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /documents/mandatory-status/:userId ───────────────────────────────────
exports.getMandatoryDocStatus = async (req, res) => {
  try {
    const userId = req.params.userId;
    const mandatory = Document.MANDATORY_TYPES;
    const uploaded  = await Document.findAll({ where: { userId, type: mandatory } });
    const uploadedTypes = uploaded.map(d => d.type);

    const status = mandatory.map(type => ({
      type,
      uploaded: uploadedTypes.includes(type),
      doc: uploaded.find(d => d.type === type) || null,
    }));

    res.json(status);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /documents/:id/download ───────────────────────────────────────────────
exports.downloadDocument = async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    const actor = req.user;
    if (actor.role === 'employee') {
      if (Number(doc.userId) !== Number(actor.id)) return res.status(403).json({ message: 'Access denied' });
    }

    const filePath = path.join(UPLOAD_DIR, doc.filePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found on server' });
    res.download(filePath, doc.fileName);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /documents/:id/view ───────────────────────────────────────────────────
exports.viewDocument = async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    const actor = req.user;
    if (actor.role === 'employee') {
      if (Number(doc.userId) !== Number(actor.id)) return res.status(403).json({ message: 'Access denied' });
    }

    const filePath = path.join(UPLOAD_DIR, doc.filePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found on server' });

    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /documents/:id ────────────────────────────────────────────────────
exports.deleteDocument = async (req, res) => {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Document not found' });

    const actor = req.user;
    if (actor.role === 'employee') {
      // Compare as numbers to avoid string/int type mismatch from JWT payload
      // Check userId (the document owner) not uploadedBy (the uploader),
      // so employees can delete docs an admin uploaded on their behalf.
      if (Number(doc.userId) !== Number(actor.id)) {
        return res.status(403).json({ message: 'Access denied: this document does not belong to you' });
      }
    }

    // Delete physical file
    const filePath = path.join(UPLOAD_DIR, doc.filePath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await doc.destroy();
    res.json({ message: 'Document deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── Internal helper: update user verificationStatus based on mandatory docs ──
async function _checkAndUpdateVerificationStatus(userId) {
  try {
    const user = await User.findByPk(userId);
    if (!user || !['employee', 'manager'].includes(user.role)) return;
    if (user.verificationStatus === 'verified') return;

    const mandatory    = Document.MANDATORY_TYPES;
    const uploadedTypes = await Document.findAll({ where: { userId, type: mandatory } }).then(d => d.map(x => x.type));
    const allUploaded  = mandatory.every(t => uploadedTypes.includes(t));

    if (allUploaded && user.verificationStatus === 'pending_docs') {
      user.verificationStatus = 'docs_submitted';
      await user.save();
    }
  } catch (_) { /* silent */ }
}
