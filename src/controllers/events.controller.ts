import { ClientsManager } from "../managers/clients.manager.js"
import { v4 as uuidv4 } from "uuid";

export const eventsController = (req: any, res: any, clientsManager: ClientsManager) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
  
    const id = uuidv4();
    clientsManager.addClient(res, id);
  
    req.on("close", () => {
      clientsManager.removeClient(id);
    });
}