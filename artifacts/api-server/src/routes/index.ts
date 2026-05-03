import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksRouter from "./stocks";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/stocks", stocksRouter);

export default router;
