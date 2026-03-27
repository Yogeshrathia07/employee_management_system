const { Op } = require('sequelize');
const { Notification, NotificationRead, User } = require('../models');

// ── GET /notifications ────────────────────────────────────────────────────────
exports.getNotifications = async (req, res) => {
  try {
    const { role, companyId, id: userId } = req.user;
    let where = {};

    if (role === 'employee' || role === 'manager') {
      where.companyId = companyId;
      where.status = 'active';
    } else if (role === 'admin') {
      where.companyId = companyId;
    }

    const notifs = await Notification.findAll({
      where,
      include: [{ model: User, as: 'creator', attributes: ['id', 'name'] }],
      order: [['createdAt', 'DESC']],
    });

    // Attach isRead per notification for this user
    const reads = await NotificationRead.findAll({ where: { userId } });
    const readIds = new Set(reads.map(r => r.notificationId));
    const result  = notifs.map(n => ({ ...n.toJSON(), isRead: readIds.has(n.id) }));

    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /notifications/unread-count ──────────────────────────────────────────
exports.getUnreadCount = async (req, res) => {
  try {
    const { role, companyId, id: userId } = req.user;
    let where = {};
    if (role === 'employee' || role === 'manager') {
      where.companyId = companyId;
      where.status = 'active';
    } else if (role === 'admin') {
      where.companyId = companyId;
    }

    const total = await Notification.count({ where });
    const read  = await NotificationRead.count({ where: { userId } });
    res.json({ unread: Math.max(0, total - read) });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PATCH /notifications/:id/read ─────────────────────────────────────────────
exports.markRead = async (req, res) => {
  try {
    const notifId = req.params.id;
    const userId  = req.user.id;
    await NotificationRead.findOrCreate({ where: { notificationId: notifId, userId } });
    res.json({ message: 'Marked as read' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PATCH /notifications/mark-all-read ───────────────────────────────────────
exports.markAllRead = async (req, res) => {
  try {
    const { role, companyId, id: userId } = req.user;
    let where = {};
    if (role === 'employee' || role === 'manager') { where.companyId = companyId; where.status = 'active'; }
    else if (role === 'admin') { where.companyId = companyId; }

    const notifs = await Notification.findAll({ where, attributes: ['id'] });
    const records = notifs.map(n => ({ notificationId: n.id, userId }));
    await NotificationRead.bulkCreate(records, { ignoreDuplicates: true });
    res.json({ message: 'All marked as read' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── POST /notifications ───────────────────────────────────────────────────────
exports.createNotification = async (req, res) => {
  try {
    const { title, message, type } = req.body;
    if (!title) return res.status(400).json({ message: 'Title is required' });

    const data = {
      title, message: message || '',
      type: type || 'info',
      companyId: req.user.companyId,
      createdBy: req.user.id,
      status: 'active',
    };

    if (req.file) {
      data.fileName = req.file.originalname;
      data.filePath = req.file.filename;
      data.fileSize = req.file.size;
      data.mimeType = req.file.mimetype;
    }

    const notif = await Notification.create(data);
    const populated = await Notification.findByPk(notif.id, {
      include: [{ model: User, as: 'creator', attributes: ['id', 'name'] }],
    });
    res.status(201).json({ ...populated.toJSON(), isRead: false });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PATCH /notifications/:id — edit (admin/superadmin) ───────────────────────
exports.editNotification = async (req, res) => {
  try {
    const notif = await Notification.findByPk(req.params.id);
    if (!notif) return res.status(404).json({ message: 'Notification not found' });

    const { title, message, type } = req.body;
    if (title)   notif.title   = title;
    if (message !== undefined) notif.message = message;
    if (type)    notif.type    = type;
    await notif.save();
    res.json(notif);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PATCH /notifications/:id/toggle ──────────────────────────────────────────
exports.toggleNotification = async (req, res) => {
  try {
    const notif = await Notification.findByPk(req.params.id);
    if (!notif) return res.status(404).json({ message: 'Notification not found' });
    notif.status = notif.status === 'active' ? 'inactive' : 'active';
    await notif.save();
    res.json(notif);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── DELETE /notifications/:id ─────────────────────────────────────────────────
exports.deleteNotification = async (req, res) => {
  try {
    const notif = await Notification.findByPk(req.params.id);
    if (!notif) return res.status(404).json({ message: 'Notification not found' });
    await notif.destroy();
    res.json({ message: 'Notification deleted' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── GET /notifications/:id/download ──────────────────────────────────────────
exports.downloadFile = async (req, res) => {
  try {
    const path = require('path');
    const fs   = require('fs');
    const notif = await Notification.findByPk(req.params.id);
    if (!notif)            return res.status(404).json({ message: 'Notification not found' });
    if (!notif.filePath)   return res.status(404).json({ message: 'No file attached' });

    const filePath = path.join(__dirname, '..', 'uploads', 'documents', notif.filePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found on server' });
    res.download(filePath, notif.fileName);
  } catch (err) { res.status(500).json({ message: err.message }); }
};
