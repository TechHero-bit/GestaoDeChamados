import "dotenv/config";
import app from "./app.js";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Help Desk Backend rodando em http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});
