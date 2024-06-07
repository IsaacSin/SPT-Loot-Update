import * as fs from "node:fs";
import * as path from "node:path";

import { DependencyContainer } from "tsyringe";

import { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import { IDatabaseTables } from "@spt-aki/models/spt/server/IDatabaseTables";
import { IPostDBLoadMod } from "@spt-aki/models/external/IPostDBLoadMod";
import { JsonUtil } from "@spt-aki/utils/JsonUtil";
import { ILocation } from "@spt-aki/models/eft/common/ILocation";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { LogTextColor } from "@spt-aki/models/spt/logging/LogTextColor";

class Mod implements IPostDBLoadMod {
    private database: IDatabaseTables;
    private jsonUtil: JsonUtil;
    private logger: ILogger;
    private newItemBlacklist: string[];

    public postDBLoad(container: DependencyContainer): void {

        this.database = container.resolve<DatabaseServer>("DatabaseServer").getTables();
        this.jsonUtil = container.resolve<JsonUtil>("JsonUtil");
        this.logger = container.resolve<ILogger>("WinstonLogger");

        this.newItemBlacklist = [
            "6614217b6d9d5abcad0ff098", // The Unheard's phone - "q_item_phone_unknown"
            "6614230055afee107f05e998", // The Unheard's phone - "q_item_phone_unknown_2"
            "661421c7c1f2f548c50ee649", // The Unheard's laptop - "q_item_toughbook_quest_arr_unknown"
            "661423200d240a5f5d0f679b", // The Unheard's laptop - "q_item_toughbook_quest_arr_2"
            "660bbc47c38b837877075e47", // Encrypted flash drive - "item_flash_card_encrypted"
            "6614238e0d240a5f5d0f679d", // Skier and Peacekeeper correspondence - "item_quest_letter_dialog"
            "661666458c2aa9cb1602503b", // Hard drive - "q_item_disk_quest_arr"
            "66015072e9f84d5680039678", // 20x1mm toy gun - "weapon_ussr_pd_20x1mm"
            "6601546f86889319850bd566", // 20x1mm disk - "patron_20x1mm"
            "66015dc4aaad2f54cb04c56a", // Toy gun 20x1mm 20-round magazine - "mag_pd_ussr_toygun_std_20x1mm_18"
            "66507eabf5ddb0818b085b68"  // 2A2-(b-TG) stimulant injector - "2A2-(b-TG)"
        ]

        this.backportLootChanges();
        this.logger.log("Loot Updated. Have a nice day.", LogTextColor.MAGENTA);
    }

    public backportLootChanges(): void {
        const locations = new Map<string, string>();
        locations.set("Factory", "factory4_day");
        locations.set("Customs", "bigmap");
        locations.set("Woods", "woods");
        locations.set("Shoreline", "shoreline");
        locations.set("Interchange", "interchange");
        locations.set("Laboratory", "laboratory");
        locations.set("ReserveBase", "rezervbase");
        locations.set("Lighthouse", "lighthouse");
        locations.set("Streets of Tarkov", "tarkovstreets");
        locations.set("Sandbox", "sandbox");
        const dbPath = path.resolve(__dirname, "../db");

        for (const arr of locations) {
            const location: ILocation = this.database.locations[arr[1]];
            location.looseLoot = this.jsonUtil.deserialize(fs.readFileSync(`${dbPath}/${arr[1]}/looseLoot.json`, "utf-8"));
            this.blacklistLooseLoot(location);
            
            this.database.loot.staticContainers[arr[0]] = this.jsonUtil.deserialize(fs.readFileSync(`${dbPath}/${arr[1]}/staticContainers.json`, "utf-8"));
        }
        // Factory day/night share static containers, but not loose loot.
        const nightFactory = this.database.locations.factory4_night;
        nightFactory.looseLoot = this.jsonUtil.deserialize(fs.readFileSync(`${dbPath}/factory4_night/looseLoot.json`, "utf-8"));
        this.blacklistLooseLoot(nightFactory);
    }

    public blacklistLooseLoot(location: ILocation): void {
        location.looseLoot.spawnpointsForced = location.looseLoot.spawnpointsForced.filter(goodSpawn => 
            // Check all entries of Items
            goodSpawn.template.Items.find(item => 
                this.newItemBlacklist.includes(item._tpl)
            // If find(...) === undefined then none of the items matched the blacklist.
            ) === undefined
        )

        for (const spawnPoint of location.looseLoot.spawnpoints) {
            spawnPoint.itemDistribution = spawnPoint.itemDistribution.filter(goodItemDist =>
                !(this.newItemBlacklist.includes(spawnPoint.template.Items.find(item => item._id === goodItemDist.composedKey.key)._tpl))
            )
        }
    }
}


module.exports = { mod: new Mod() }
