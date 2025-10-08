import express from "express";
import { createCardCheckout, createPixBoletoCheckout } from "../lib/asaas.js";

const router = express.Router();

function normalizePixBoletoResponse(resp) {
  // Resp pode ter formatos variados (dependendo da versão do lib / Asaas)
  // Tentamos extrair um array de pagamentos com {parcela, id, link}
  const payments = [];

  // Caso 1: resp.payments = [{parcela, id, link}, ...]
  if (Array.isArray(resp?.payments) && resp.payments.length) {
    for (const p of resp.payments) {
      payments.push({
        parcela: p.parcela ?? p.numero ?? null,
        id: p.id ?? null,
        link: p.link ?? p.url ?? p.invoiceUrl ?? p.bankSlipUrl ?? null,
      });
    }
    return {
      payments,
      total: resp.total ?? null,
      parcelas: resp.parcelas ?? (payments.length || null),
    };
  }

  // Caso 2: resp.links = [{ numero, url }, ...] ou resp.links = [{url, id}]
  if (Array.isArray(resp?.links) && resp.links.length) {
    resp.links.forEach((l, idx) =>
      payments.push({
        parcela: l.numero ?? idx + 1,
        id: l.id ?? null,
        link: l.url ?? l.link ?? null,
      })
    );
    return {
      payments,
      total: resp.total ?? null,
      parcelas: resp.parcelas ?? (payments.length || null),
    };
  }

  // Caso 3: resp.primeiraParcela + resp.links
  if (resp?.primeiraParcela) {
    const p = resp.primeiraParcela;
    payments.push({
      parcela: p.parcela ?? 1,
      id: p.id ?? null,
      link: p.link ?? p.url ?? p.invoiceUrl ?? p.bankSlipUrl ?? null,
    });
    if (Array.isArray(resp.links)) {
      resp.links.forEach((l, idx) =>
        payments.push({
          parcela: l.numero ?? idx + 2,
          id: l.id ?? null,
          link: l.url ?? l.link ?? null,
        })
      );
    }
    return {
      payments,
      total: resp.total ?? null,
      parcelas: resp.parcelas ?? (payments.length || null),
    };
  }

  // Caso 4: resp is the raw single payment object (pay) or array-like
  // Ex: you might receive a single payment from /payments
  if (resp && typeof resp === "object") {
    // If resp has invoiceUrl/bankSlipUrl => treat as single payment
    if (resp.invoiceUrl || resp.bankSlipUrl || resp.url || resp.link) {
      payments.push({
        parcela: resp.parcela ?? 1,
        id: resp.id ?? null,
        link: resp.invoiceUrl ?? resp.bankSlipUrl ?? resp.url ?? resp.link,
      });
      return {
        payments,
        total: resp.total ?? null,
        parcelas: resp.parcelas ?? 1,
      };
    }

    // Try to detect nested objects with invoiceUrl
    for (const key of Object.keys(resp)) {
      const v = resp[key];
      if (v && typeof v === "object" && (v.invoiceUrl || v.bankSlipUrl || v.url || v.link)) {
        payments.push({
          parcela: v.parcela ?? 1,
          id: v.id ?? null,
          link: v.invoiceUrl ?? v.bankSlipUrl ?? v.url ?? v.link,
        });
      }
    }
    if (payments.length) {
      return {
        payments,
        total: resp.total ?? null,
        parcelas: resp.parcelas ?? payments.length,
      };
    }
  }

  // Fallback: não conseguimos normalizar (retorna resp cru)
  return { payments: [], raw: resp };
}

// --- Cartão (hosted checkout com parcelamento no cartão) ---
router.post("/card", async (req, res) => {
  try {
    const { buyer, items } = req.body ?? {};

    // validações básicas
    if (!buyer || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "buyer e items (array) são obrigatórios." });
    }

    const result = await createCardCheckout({ buyer, items });

    // espera { checkoutUrl, holdId } (ou invoiceUrl etc)
    const checkoutUrl = result?.checkoutUrl ?? result?.invoiceUrl ?? result?.url ?? null;
    const holdId = result?.holdId ?? result?.id ?? null;

    if (!checkoutUrl) {
      // responde com o objeto completo para debug
      return res.status(200).json({ message: "Checkout criado (sem checkoutUrl retornado)", result });
    }

    return res.json({ checkoutUrl, holdId });
  } catch (err) {
    console.error("Erro /card:", err.response?.data ?? err.message);
    const status = err.response?.status ?? 400;
    return res.status(status).json({
      error: err.response?.data ?? err.message ?? "Erro inesperado ao criar checkout cartão",
    });
  }
});

// --- PIX / BOLETO (gera múltiplas cobranças conforme installments) ---
router.post("/pixboleto", async (req, res) => {
  try {
    const { buyer, items, payment } = req.body ?? {};

    if (!buyer || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "buyer e items (array) são obrigatórios." });
    }

    // payment.method deve ser "PIX" ou "BOLETO"
    const method = payment?.method ?? null;
    if (!["PIX", "BOLETO"].includes(method)) {
      return res.status(400).json({ error: 'payment.method deve ser "PIX" ou "BOLETO".' });
    }

    // chama a função de criação (sua lib lida com installments)
    const resp = await createPixBoletoCheckout({ buyer, items, payment });

    // normaliza o retorno para um formato previsível
    const normalized = normalizePixBoletoResponse(resp);

    // se não encontramos pagamentos, devolvemos o retorno cru também para debug
    if ((!normalized.payments || normalized.payments.length === 0) && normalized.raw) {
      return res.status(200).json({
        payments: [],
        notice: "Nenhum link foi detectado automaticamente; verifique o retorno cru em 'raw'.",
        raw: normalized.raw,
      });
    }

    return res.json(normalized);
  } catch (err) {
    console.error("Erro /pixboleto:", err.response?.data ?? err.message);
    const status = err.response?.status ?? 400;
    return res.status(status).json({
      error: err.response?.data ?? err.message ?? "Erro inesperado ao gerar cobranças PIX/BOLETO",
    });
  }
});

export default router;
