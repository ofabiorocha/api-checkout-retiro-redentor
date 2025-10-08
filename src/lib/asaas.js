import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const ASAAS_ENV = process.env.ASAAS_ENV || "sandbox"; // "sandbox" | "prod"
const ASAAS_API =
  ASAAS_ENV === "prod"
    ? "https://www.asaas.com/api/v3"
    : "https://sandbox.asaas.com/api/v3";

// host público (para fallback de links)
const ASAAS_HOST =
  ASAAS_ENV === "prod" ? "https://www.asaas.com" : "https://sandbox.asaas.com";

const ASAAS_TOKEN = process.env.ASAAS_TOKEN;
if (!ASAAS_TOKEN) {
  console.warn("⚠️  ASAAS_TOKEN não definido no .env");
}

const api = axios.create({
  baseURL: ASAAS_API,
  headers: {
    "Content-Type": "application/json",
    access_token: ASAAS_TOKEN,
  },
});

function onlyDigits(s = "") {
  return String(s).replace(/\D/g, "");
}

// soma meses respeitando fim de mês
function addMonthsISO(date, monthsToAdd) {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + monthsToAdd);
  if (d.getDate() < day) {
    d.setDate(0);
  }
  return d.toISOString().split("T")[0];
}

/**
 * Cartão: cria paymentLink (hosted checkout) com parcelamento no cartão.
 * Retorna { checkoutUrl, holdId }
 */
export async function createCardCheckout({ buyer, items }) {
  try {
    // 1) cria cliente
    const { data: customer } = await api.post("/customers", {
      name: buyer.name,
      email: buyer.email,
      cpfCnpj: onlyDigits(buyer.cpf),
      phone: onlyDigits(buyer.phone),
    });

    // 2) total
    const totalValue = items.reduce(
      (sum, item) => sum + Number(item.unitPrice) * Number(item.qty),
      0
    );

    // 3) cria payment link (checkout hospedado) — permite parcelamento no cartão com juros
    const { data: paymentData } = await api.post("/paymentLinks", {
      name: `Checkout ${buyer.name}`,
      description: items.map(i => `${i.qty}x ${i.name}`).join(", "),
      chargeType: "DETACHED",
      billingType: "UNDEFINED", // deixa o checkout decidir (cartão)
      value: totalValue,
      allowInstallmentPayment: true,
      maxInstallmentCount: 12,
      interest: true, // juros ficam por conta do comprador
      fine: 0,
      customer: customer.id,
      // NOTA: callback só se você tiver domínio configurado na conta Asaas
      // callback: { successUrl: "https://seusite.com/sucesso", autoRedirect: true }
    });

    return {
      checkoutUrl: paymentData.invoiceUrl ?? paymentData.url ?? null,
      holdId: paymentData.id ?? null,
    };
  } catch (err) {
    // log detalhado para debugging
    if (err.response?.data) {
      console.error("❌ Erro Asaas (createCardCheckout):", JSON.stringify(err.response.data, null, 2));
    } else {
      console.error("❌ Erro createCardCheckout:", err.message);
    }
    throw err;
  }
}

/**
 * PIX / BOLETO: gera N cobranças (parcelamento sem juros) dividindo o total
 * Retorna sempre um objeto com payments: [{parcela, id, link, dueDate, value}, ...], total, parcelas
 *
 * payment = { method: "PIX" | "BOLETO", installments: number }
 */
export async function createPixBoletoCheckout({ buyer, items, payment }) {
  try {
    const method = payment?.method;
    if (!["PIX", "BOLETO"].includes(method)) {
      throw new Error('payment.method deve ser "PIX" ou "BOLETO"');
    }

    // cria (ou tenta) cliente
    const { data: customer } = await api.post("/customers", {
      name: buyer.name,
      email: buyer.email,
      cpfCnpj: onlyDigits(buyer.cpf),
      phone: onlyDigits(buyer.phone),
    });

    const total = items.reduce(
      (sum, item) => sum + Number(item.unitPrice) * Number(item.qty),
      0
    );

    const parcelas =
      payment?.installments && Number(payment.installments) > 1
        ? Math.min(Number(payment.installments), 6) // limita a 6x como requisito seu
        : 1;

    // arredondamento por centavos: N-1 parcelas com floor, última recebe resto
    const parcelaBruta = Math.floor((total / parcelas) * 100) / 100;
    const somaPrimeiras = parcelaBruta * (parcelas - 1);
    const ultimaParcela = Number((total - somaPrimeiras).toFixed(2));

    const hoje = new Date();
    const payments = [];

    for (let i = 0; i < parcelas; i++) {
      const valor = i < parcelas - 1 ? parcelaBruta : ultimaParcela;

      // cria pagamento (cada parcela é uma cobrança separada)
      const { data: pay } = await api.post("/payments", {
        customer: customer.id,
        billingType: method, // "PIX" ou "BOLETO"
        value: valor,
        description: `Parcela ${i + 1}/${parcelas} - ${items
          .map(it => `${it.qty}x ${it.name}`)
          .join(", ")}`,
        dueDate: addMonthsISO(hoje, i), // mensal
        // fine / interest para BOLETO se desejar
        // fine: 0, interest: 0
      });

      // extrai link — Asaas varia nomes de campo por versão
      let link = null;
      if (method === "PIX") {
        link = pay.invoiceUrl ?? pay.invoiceUrlPix ?? pay.qrCode ?? pay.qrCodeUrl ?? pay.link ?? null;
      } else {
        // BOLETO
        link = pay.bankSlipUrl ?? pay.invoiceUrl ?? pay.url ?? pay.link ?? null;
      }

      // fallback: constrói uma URL pública do Asaas para visualizar cobrança
      if (!link) {
        // pay.id geralmente existe
        link = `${ASAAS_HOST}/payment/${pay.id}`;
      }

      payments.push({
        parcela: i + 1,
        id: pay.id ?? null,
        link,
        dueDate: pay.dueDate ?? addMonthsISO(hoje, i),
        value: Number(valor),
      });
    }

    return {
      payments,
      total: Number(total),
      parcelas,
    };
  } catch (err) {
    if (err.response?.data) {
      console.error("❌ Erro Asaas (createPixBoletoCheckout):", JSON.stringify(err.response.data, null, 2));
    } else {
      console.error("❌ Erro createPixBoletoCheckout:", err.message);
    }
    throw err;
  }
}
