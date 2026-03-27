const fs = require('fs');
const path = require('path');
const { AppSetting } = require('../models');

const LOGIN_HERO_KEY = 'loginHeroImage';
const LOGIN_HERO_FIT_KEY = 'loginHeroFit';
const LOGIN_HERO_POSITION_KEY = 'loginHeroPosition';

async function getSetting(key) {
  return AppSetting.findOne({ where: { key } });
}

exports.getPublicLoginHero = async (req, res) => {
  try {
    const [setting, fitSetting, positionSetting] = await Promise.all([
      getSetting(LOGIN_HERO_KEY),
      getSetting(LOGIN_HERO_FIT_KEY),
      getSetting(LOGIN_HERO_POSITION_KEY),
    ]);
    res.json({
      imageUrl: setting && setting.value ? '/api/settings/login-hero/image' : '',
      fit: fitSetting && fitSetting.value ? fitSetting.value : 'contain',
      position: positionSetting && positionSetting.value ? positionSetting.value : 'center center'
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getLoginHeroImage = async (req, res) => {
  try {
    const setting = await getSetting(LOGIN_HERO_KEY);
    if (!setting || !setting.value) return res.status(404).json({ message: 'No login image configured' });

    if (setting.value.startsWith('http')) return res.redirect(setting.value);

    const filePath = path.join(__dirname, '..', 'uploads', 'photos', setting.value);
    if (!fs.existsSync(filePath)) return res.status(404).json({ message: 'File not found' });
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.upsertLoginHero = async (req, res) => {
  try {
    const fit = ['contain', 'cover'].includes(req.body.fit) ? req.body.fit : 'contain';
    const position = ['center center', 'top center', 'bottom center', 'center left', 'center right'].includes(req.body.position)
      ? req.body.position
      : 'center center';

    if (!req.file && !req.body.fit && !req.body.position) {
      return res.status(400).json({ message: 'No image or adjustments provided' });
    }

    let setting = await getSetting(LOGIN_HERO_KEY);
    if (req.file && setting && setting.value && !setting.value.startsWith('http')) {
      const oldPath = path.join(__dirname, '..', 'uploads', 'photos', setting.value);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    if (req.file) {
      if (!setting) {
        setting = await AppSetting.create({ key: LOGIN_HERO_KEY, value: req.file.filename });
      } else {
        setting.value = req.file.filename;
        await setting.save();
      }
    }

    const [fitSetting, positionSetting] = await Promise.all([
      getSetting(LOGIN_HERO_FIT_KEY),
      getSetting(LOGIN_HERO_POSITION_KEY),
    ]);

    if (!fitSetting) await AppSetting.create({ key: LOGIN_HERO_FIT_KEY, value: fit });
    else { fitSetting.value = fit; await fitSetting.save(); }

    if (!positionSetting) await AppSetting.create({ key: LOGIN_HERO_POSITION_KEY, value: position });
    else { positionSetting.value = position; await positionSetting.save(); }

    res.json({
      message: 'Login page image updated',
      imageUrl: setting && setting.value ? '/api/settings/login-hero/image' : '',
      fit,
      position
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
