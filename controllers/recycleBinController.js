const { Op } = require('sequelize');
const { RecycleBin, User, Leave, Timesheet, Salary, Document, Notification, Company } = require('../models');

// Helper: move item to recycle bin before deleting
async function moveToRecycleBin(itemType, itemId, actor, itemData, itemTitle) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  const snapshot = JSON.parse(JSON.stringify(itemData));
  const derivedCompanyId = actor.companyId || snapshot.companyId || snapshot.company?.id || null;

  await RecycleBin.create({
    itemType,
    itemId,
    itemData: snapshot,
    itemTitle: itemTitle || `${itemType} #${itemId}`,
    deletedBy: actor.id,
    deletedByName: actor.name,
    companyId: derivedCompanyId,
    expiresAt,
  });
}

// GET /recycle-bin — superadmin only
exports.getItems = async (req, res) => {
  try {
    // Auto-purge expired items
    await RecycleBin.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });

    const where = {};
    if (req.query.type) where.itemType = req.query.type;
    if (req.user.role === 'admin') {
      where.companyId = req.user.companyId;
    } else if (req.query.companyId) {
      where.companyId = req.query.companyId;
    }

    const items = await RecycleBin.findAll({
      where,
      include: [{ model: User, as: 'deleter', attributes: ['id', 'name'] }],
      order: [['createdAt', 'DESC']],
    });
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /recycle-bin/:id/restore — superadmin restores a deleted item
exports.restoreItem = async (req, res) => {
  try {
    const item = await RecycleBin.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found in recycle bin' });
    if (req.user.role === 'admin' && item.companyId !== req.user.companyId) {
      return res.status(403).json({ message: 'You can only restore items from your company' });
    }

    let data = item.itemData;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return res.status(400).json({ message: 'Stored recycle-bin data is invalid' });
      }
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ message: 'Stored recycle-bin data is missing' });
    }

    const ModelMap = { user: User, leave: Leave, timesheet: Timesheet, salary: Salary, document: Document, notification: Notification, company: Company };
    const Model = ModelMap[item.itemType];
    if (!Model) return res.status(400).json({ message: 'Unknown item type' });

    const duplicateWhereMap = {
      user: data.email ? { email: data.email } : null,
      leave: (data.userId && data.fromDate && data.toDate && data.type) ? { userId: data.userId, fromDate: data.fromDate, toDate: data.toDate, type: data.type } : null,
      timesheet: (data.userId && data.weekStart && data.weekEnd) ? { userId: data.userId, weekStart: data.weekStart, weekEnd: data.weekEnd } : null,
      salary: (data.userId && data.month && data.year) ? { userId: data.userId, month: data.month, year: data.year } : null,
      document: (data.userId && data.type && data.originalName && data.createdAt) ? { userId: data.userId, type: data.type, originalName: data.originalName, createdAt: data.createdAt } : null,
      notification: (data.title && data.companyId) ? { title: data.title, companyId: data.companyId } : null,
      company: data.email ? { email: data.email } : null,
    };

    const duplicateWhere = duplicateWhereMap[item.itemType];
    if (duplicateWhere) {
      const duplicate = await Model.findOne({ where: duplicateWhere, paranoid: false });
      if (duplicate) {
        await item.destroy();
        return res.json({ message: `${item.itemType} already exists, recycle entry removed` });
      }
    }

    // Remove id and timestamps so Sequelize creates a fresh record
    delete data.id;
    delete data.createdAt;
    delete data.updatedAt;
    delete data.deletedAt;

    // For Document (paranoid), restore might need special handling
    if (item.itemType === 'document') {
      // Try to restore paranoid-deleted record first
      const existing = await Document.findOne({ where: { id: item.itemId }, paranoid: false });
      if (existing) {
        await existing.restore();
        await item.destroy();
        return res.json({ message: 'Document restored successfully' });
      }
    }

    await Model.create(data, { hooks: item.itemType !== 'user' }); // skip password hash hook for users
    await item.destroy();
    res.json({ message: `${item.itemType} restored successfully` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /recycle-bin/:id — permanently delete
exports.permanentDelete = async (req, res) => {
  try {
    const item = await RecycleBin.findByPk(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    if (req.user.role === 'admin' && item.companyId !== req.user.companyId) {
      return res.status(403).json({ message: 'You can only delete items from your company' });
    }
    await item.destroy();
    res.json({ message: 'Permanently deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// DELETE /recycle-bin — empty all
exports.emptyBin = async (req, res) => {
  try {
    const where = req.user.role === 'admin' ? { companyId: req.user.companyId } : {};
    await RecycleBin.destroy({ where });
    res.json({ message: 'Recycle bin emptied' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// Export helper for other controllers to use
exports.moveToRecycleBin = moveToRecycleBin;
