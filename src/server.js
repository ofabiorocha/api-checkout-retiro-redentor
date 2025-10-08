import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import checkoutRouter from "./routes/checkout.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/checkout", checkoutRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 API rodando em http://localhost:${PORT}`);
});
