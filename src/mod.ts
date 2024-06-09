import * as fs from "node:fs";
import * as path from "node:path";

import { DependencyContainer } from "tsyringe";

import { DatabaseServer } from "@spt-aki/servers/DatabaseServer";
import { IDatabaseTables } from "@spt-aki/models/spt/server/IDatabaseTables";
import { IPostDBLoadMod } from "@spt-aki/models/external/IPostDBLoadMod";
import { IPreAkiLoadMod } from "@spt-aki/models/external/IPreAkiLoadMod";
import { JsonUtil } from "@spt-aki/utils/JsonUtil";
import { ILocation, IStaticContainer } from "@spt-aki/models/eft/common/ILocation";
import { ILogger } from "@spt-aki/models/spt/utils/ILogger";
import { LogTextColor } from "@spt-aki/models/spt/logging/LogTextColor";
import { IStaticAmmoDetails, IStaticLootDetails } from "@spt-aki/models/eft/common/tables/ILootBase";
import { LocationGenerator } from "@spt-aki/generators/LocationGenerator";
import { ILocationBase } from "@spt-aki/models/eft/common/ILocationBase";
import { SpawnpointTemplate } from "@spt-aki/models/eft/common/ILooseLoot";
import { ConfigServer } from "@spt-aki/servers/ConfigServer";
import { ConfigTypes } from "@spt-aki/models/enums/ConfigTypes";
import { ILocationConfig } from "@spt-aki/models/spt/config/ILocationConfig";
import { ILootConfig } from "@spt-aki/models/spt/config/ILootConfig";
import { LocalisationService } from "@spt-aki/services/LocalisationService";
import { RandomUtil } from "@spt-aki/utils/RandomUtil";

class Mod implements IPreAkiLoadMod, IPostDBLoadMod {
    private static container: DependencyContainer;

    private database: IDatabaseTables;
    private jsonUtil: JsonUtil;
    private logger: ILogger;
    private futureItemBlacklist: string[];
    private config: {changeStaticLoot: boolean};
    private locations: Map<string, string>;
    private staticLootDists: Map<string, Record<string, IStaticLootDetails>>;
    private configPath = path.resolve(__dirname, "../config/config.json");
    private dbPath = path.resolve(__dirname, "../db");

    public preAkiLoad(container: DependencyContainer): void {
        const jsonUtil = container.resolve<JsonUtil>("JsonUtil");
        this.config = jsonUtil.deserialize(fs.readFileSync(this.configPath, "utf-8"), "config.json");
        if (this.config.changeStaticLoot) {
            container.afterResolution("LocationGenerator", (_t, result: LocationGenerator) => {
                result.generateStaticContainers = (locationBase: ILocationBase, staticAmmoDist: Record<string, IStaticAmmoDetails[]>) => {
                    return this.generateStaticContainers(locationBase, staticAmmoDist);
                }
            }, { frequency: "Always" });
        }
    }

    public postDBLoad(container: DependencyContainer): void {
        Mod.container = container;
        this.database = Mod.container.resolve<DatabaseServer>("DatabaseServer").getTables();
        this.logger = Mod.container.resolve<ILogger>("WinstonLogger");
        this.jsonUtil = Mod.container.resolve<JsonUtil>("JsonUtil");

        this.locations = new Map<string, string>();
        this.locations.set("Factory", "factory4_day");
        this.locations.set("FactoryNight", "factory4_night");
        this.locations.set("Customs", "bigmap");
        this.locations.set("Woods", "woods");
        this.locations.set("Shoreline", "shoreline");
        this.locations.set("Interchange", "interchange");
        this.locations.set("Laboratory", "laboratory");
        this.locations.set("ReserveBase", "rezervbase");
        this.locations.set("Lighthouse", "lighthouse");
        this.locations.set("Streets of Tarkov", "tarkovstreets");
        this.locations.set("Sandbox", "sandbox");
        this.staticLootDists = new Map<string, Record<string, IStaticLootDetails>>();

        this.futureItemBlacklist = [
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

        this.fixGivingTree();
        this.updateLoot();
        
        if (this.config.changeStaticLoot) {
            this.logger.log("[Loot Update] Static loot lists generated.", LogTextColor.MAGENTA);
        }
        this.logger.log("[Loot Update] Loot updated. Have a nice day <3", LogTextColor.MAGENTA);
    }

    public fixGivingTree(): void {
        const configServer = Mod.container.resolve<ConfigServer>("ConfigServer");
        const lootConfig: ILootConfig = configServer.getConfig(ConfigTypes.LOOT);

        // This contains extra spawns for keycards in 3.8.x
        lootConfig.looseLoot.bigmap = [];
    }

    public updateLoot(): void {
        for (const arr of this.locations) {
            const locationName: string = arr[0];
            const locationId: string = arr[1];
            const location: ILocation = this.database.locations[locationId];

            // Update loose loot
            location.looseLoot = this.jsonUtil.deserialize(fs.readFileSync(`${this.dbPath}/${locationId}/looseLoot.json`, "utf-8"));
            this.blacklistLooseLoot(location);
            
            // Update static containers
            // Don't set static containers for Factory night because it's shared with Factory day.
            if (locationName != "FactoryNight") {
                this.database.loot.staticContainers[locationName] = this.jsonUtil.deserialize(fs.readFileSync(`${this.dbPath}/${locationId}/staticContainers.json`, "utf-8"));
            }

            // Generate staticLootDist list
            if (this.config.changeStaticLoot) {
                this.loadStaticLoot(locationId);
            }
        }
    }

    public blacklistLooseLoot(location: ILocation): void {
        // For spawnpointsForced (quest items) we remove the whole spawn point if we find a blacklisted item.
        location.looseLoot.spawnpointsForced = location.looseLoot.spawnpointsForced.filter(goodSpawn => 
            goodSpawn.template.Items.find(item => 
                this.futureItemBlacklist.includes(item._tpl)
            // If find(...) === undefined then none of the items matched the blacklist.
            ) === undefined
        )

        // For spawnPoint we remove the individual itemDist for the blacklisted item because spawnPoints are often shared between many different items.
        for (const spawnPoint of location.looseLoot.spawnpoints) {
            spawnPoint.itemDistribution = spawnPoint.itemDistribution.filter(goodItemDist =>
                // itemDist contains a composedKey that matches a template.Items entry. We need to get the Item to compare tpl to blacklist.
                !(this.futureItemBlacklist.includes(spawnPoint.template.Items.find(item => 
                    item._id === goodItemDist.composedKey.key)._tpl)
                )
            )
            /*
            // Remove actual item entries, unnecessary unless it influences the randomization. 
            spawnPoint.template.Items = spawnPoint.template.Items.filter(goodItem => 
                !(this.futureItemBlacklist.includes(goodItem._tpl))
            )
            */
        }
    }

    public loadStaticLoot(locationId: string): void {
        const location: ILocation = this.database.locations[locationId];
        const staticLootDist: Record<string, IStaticLootDetails> = this.jsonUtil.deserialize(fs.readFileSync(`${this.dbPath}/${locationId}/staticLoot.json`, "utf-8"), `${locationId}/staticLoot.json`);
        for (const containerTypeId in staticLootDist) {
            staticLootDist[containerTypeId].itemDistribution = staticLootDist[containerTypeId].itemDistribution.filter(goodItems => 
                !(this.futureItemBlacklist.includes(goodItems.tpl))
            )
        }
        // location.base.Id uses different capitalization than the file path ids.
        this.staticLootDists.set(location.base.Id, staticLootDist);
    }

    public generateStaticContainers(locationBase: ILocationBase, staticAmmoDist: Record<string, IStaticAmmoDetails[]>): SpawnpointTemplate[] {
        const locationGenerator = Mod.container.resolve<LocationGenerator>("LocationGenerator");
        const jsonUtil = Mod.container.resolve<JsonUtil>("JsonUtil");
        const configServer = Mod.container.resolve<ConfigServer>("ConfigServer");
        const locationConfig: ILocationConfig = configServer.getConfig(ConfigTypes.LOCATION);
        const randomUtil = Mod.container.resolve<RandomUtil>("RandomUtil");
        const localisationService = Mod.container.resolve<LocalisationService>("LocalisationService");
        this.logger.log("[Loot Update] Generating static containers.", LogTextColor.MAGENTA);


        let staticLootItemCount = 0;
        const result: SpawnpointTemplate[] = [];
        const locationId = locationBase.Id.toLowerCase();
    
        const db = Mod.container.resolve<DatabaseServer>("DatabaseServer").getTables();

        
    
        const staticWeaponsOnMapClone = jsonUtil.clone(db.loot.staticContainers[locationBase.Name]?.staticWeapons);
        if (!staticWeaponsOnMapClone) {
            this.logger.error(`Unable to find static weapon data for map: ${locationBase.Name}`);
        }
    
        // Add mounted weapons to output loot
        result.push(...staticWeaponsOnMapClone ?? []);
    
        const allStaticContainersOnMapClone = this.jsonUtil.clone(
            db.loot.staticContainers[locationBase.Name]?.staticContainers
        );
        if (!allStaticContainersOnMapClone) {
            this.logger.error(`Unable to find static container data for map: ${locationBase.Name}`);
        }
        const staticRandomisableContainersOnMap = locationGenerator.getRandomisableContainersOnMap(allStaticContainersOnMapClone); 
    
        // Containers that MUST be added to map (quest containers etc)
        const staticForcedOnMapClone = this.jsonUtil.clone(db.loot.staticContainers[locationBase.Name]?.staticForced);
        if (!staticForcedOnMapClone) {
            this.logger.error(`Unable to find forced static data for map: ${locationBase.Name}`);
        }
    
        // Keep track of static loot count
        let staticContainerCount = 0;
    
        // Find all 100% spawn containers
        const staticLootDist: Record<string, IStaticLootDetails> = this.staticLootDists.get(locationBase.Id);
        // const staticLootDist  = db.loot.staticLoot;
        const guaranteedContainers = locationGenerator.getGuaranteedContainers(allStaticContainersOnMapClone);
        staticContainerCount += guaranteedContainers.length;
    
        // Add loot to guaranteed containers and add to result
        for (const container of guaranteedContainers) {
            const containerWithLoot = locationGenerator.addLootToContainer(
                container,
                staticForcedOnMapClone,
                staticLootDist,
                staticAmmoDist,
                locationId
            );
            result.push(containerWithLoot.template);
    
            staticLootItemCount += containerWithLoot.template.Items.length;
        }
    
        this.logger.debug(`Added ${guaranteedContainers.length} guaranteed containers`);
    
        // Randomisation is turned off globally or just turned off for this map
        if (
            !(locationConfig.containerRandomisationSettings.enabled
                && locationConfig.containerRandomisationSettings.maps[locationId])
        ) {
            this.logger.debug(
                `Container randomisation disabled, Adding ${staticRandomisableContainersOnMap.length} containers to ${locationBase.Name}`
            );
            for (const container of staticRandomisableContainersOnMap) {
                const containerWithLoot = locationGenerator.addLootToContainer(
                    container,
                    staticForcedOnMapClone,
                    staticLootDist,
                    staticAmmoDist,
                    locationId
                );
                result.push(containerWithLoot.template);
    
                staticLootItemCount += containerWithLoot.template.Items.length;
            }
    
            this.logger.success(`A total of ${staticLootItemCount} static items spawned`);
    
            return result;
        }
    
        // Group containers by their groupId
        const staticContainerGroupData: IStaticContainer = db.locations[locationId].statics;
        if (!staticContainerGroupData) {
            this.logger.warning(`Map: ${locationId} lacks a statics file, skipping container generation.`);
    
            return result;
        }
        const mapping = locationGenerator.getGroupIdToContainerMappings(staticContainerGroupData, staticRandomisableContainersOnMap);
    
        // For each of the container groups, choose from the pool of containers, hydrate container with loot and add to result array
        for (const groupId in mapping) {
            const data = mapping[groupId];
    
            // Count chosen was 0, skip
            if (data.chosenCount === 0) {
                continue;
            }
    
            if (Object.keys(data.containerIdsWithProbability).length === 0) {
                this.logger.debug(
                    `Group: ${groupId} has no containers with < 100% spawn chance to choose from, skipping`
                );
                continue;
            }
    
            // EDGE CASE: These are containers without a group and have a probability < 100%
            if (groupId === "") {
                const containerIdsCopy = this.jsonUtil.clone(data.containerIdsWithProbability);
                // Roll each containers probability, if it passes, it gets added
                data.containerIdsWithProbability = {};
                for (const containerId in containerIdsCopy) {
                    if (randomUtil.getChance100(containerIdsCopy[containerId] * 100)) {
                        data.containerIdsWithProbability[containerId] = containerIdsCopy[containerId];
                    }
                }
    
                // Set desired count to size of array (we want all containers chosen)
                data.chosenCount = Object.keys(data.containerIdsWithProbability).length;
    
                // EDGE CASE: chosen container count could be 0
                if (data.chosenCount === 0) {
                    continue;
                }
            }
    
            // Pass possible containers into function to choose some
            const chosenContainerIds = locationGenerator.getContainersByProbabilty(groupId, data);
            for (const chosenContainerId of chosenContainerIds) {
                // Look up container object from full list of containers on map
                const containerObject = staticRandomisableContainersOnMap.find(staticContainer =>
                    staticContainer.template.Id === chosenContainerId
                );
                if (!containerObject) {
                    this.logger.debug(
                        `Container: ${
                            chosenContainerIds[chosenContainerId]
                        } not found in staticRandomisableContainersOnMap, this is bad`
                    );
                    continue;
                }
    
                // Add loot to container and push into result object
                const containerWithLoot = locationGenerator.addLootToContainer(
                    containerObject,
                    staticForcedOnMapClone,
                    staticLootDist,
                    staticAmmoDist,
                    locationId
                );
                result.push(containerWithLoot.template);
                staticContainerCount++;
    
                staticLootItemCount += containerWithLoot.template.Items.length;
            }
        }
    
        this.logger.success(`A total of ${staticLootItemCount} static items spawned`);
    
        this.logger.success(
            localisationService.getText("location-containers_generated_success", staticContainerCount)
        );
    
        return result;
    }
}


module.exports = { mod: new Mod() }
