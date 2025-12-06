import ytdl from "@distube/ytdl-core";

class AgentManager {
    private static instance: AgentManager;
    private agent: ytdl.Agent | undefined;

    private constructor() {
        this.initializeAgent();
    }

    public static getInstance(): AgentManager {
        if (!AgentManager.instance) {
            AgentManager.instance = new AgentManager();
        }
        return AgentManager.instance;
    }

    private initializeAgent() {
        if (process.env.YOUTUBE_COOKIES_JSON) {
            const cookies: any[] = JSON.parse(process.env.YOUTUBE_COOKIES_JSON);
            this.agent = ytdl.createAgent(cookies);
            console.log("Agente de YouTube creado con cookies.");
        }
    }

    public getAgent(): ytdl.Agent | undefined {
        return this.agent;
    }
}

export { AgentManager };