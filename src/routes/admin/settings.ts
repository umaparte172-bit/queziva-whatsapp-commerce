import { Router } from 'express';
import { ah } from '../../lib/http.js';
import { getSettings, updateSettings } from '../../services/settings.js';

export const settingsRouter = Router();

settingsRouter.get('/settings', ah(async (_req, res) => res.json({ settings: await getSettings() })));

settingsRouter.put('/settings', ah(async (req, res) => res.json({ settings: await updateSettings(req.body) })));
