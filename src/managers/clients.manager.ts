import express from "express";

class ClientsManager {
    public static instance: ClientsManager;
    public clients: Map<string, express.Response>;

    constructor() {
        this.clients = new Map<string, express.Response>();
    }

    public static getInstance(): ClientsManager {
        if (!ClientsManager.instance) {
            ClientsManager.instance = new ClientsManager();
        }
        return ClientsManager.instance;
    }

    public getClients(): Map<string, express.Response> {
        return this.clients;
    }

    public addClient(client: express.Response, id: string) {
        this.clients.set(id, client);
    }

    public removeClient(id: string) {
        this.clients.delete(id);
    }
}

export { ClientsManager }