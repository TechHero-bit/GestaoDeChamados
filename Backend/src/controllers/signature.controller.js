import * as signatureService from "../services/signature.service.js";

export async function getSignature(req, res, next) {
  try {
    return res.json(await signatureService.getUserSignature(req.user.id));
  } catch (error) {
    return next(error);
  }
}

export async function uploadSignature(req, res, next) {
  try {
    const signature = await signatureService.uploadUserSignature(req.user.id, req.file);
    return res.json({ success: true, ...signature });
  } catch (error) {
    return next(error);
  }
}

export async function updateSignatureSettings(req, res, next) {
  try {
    if (typeof req.body?.enabled !== "boolean" || Object.keys(req.body).some((key) => key !== "enabled")) {
      return res.status(400).json({ success: false, message: "enabled deve ser booleano." });
    }

    const signature = await signatureService.updateUserSignatureSettings(req.user.id, req.body.enabled);
    return res.json({ success: true, ...signature });
  } catch (error) {
    return next(error);
  }
}

export async function deleteSignature(req, res, next) {
  try {
    await signatureService.deleteUserSignature(req.user.id);
    return res.json({ success: true, enabled: false, has_signature: false, image_url: null });
  } catch (error) {
    return next(error);
  }
}
