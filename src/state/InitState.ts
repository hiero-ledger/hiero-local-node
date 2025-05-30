// SPDX-License-Identifier: Apache-2.0

import semver from'semver';
import shell from 'shelljs';
import { configDotenv } from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';
import path, { join } from 'path';
import yaml from 'js-yaml';
import { LoggerService } from '../services/LoggerService';
import { ServiceLocator } from '../services/ServiceLocator';
import { IState } from './IState';
import { CLIService } from '../services/CLIService';
import { CLIOptions } from '../types/CLIOptions';
import { FileSystemUtils } from '../utils/FileSystemUtils';
import { IOBserver } from '../controller/IObserver';
import { EventType } from '../types/EventType';
import { ConfigurationData } from '../data/ConfigurationData';
import { Configuration } from '../types/NetworkConfiguration';
import originalNodeConfiguration from '../configuration/originalNodeConfiguration.json';
import { DockerService } from '../services/DockerService';
import {
    APPLICATION_YML_RELATIVE_PATH,
    CHECK_SUCCESS,
    INIT_STATE_BOOTSTRAPPED_PROP_SET,
    INIT_STATE_CONFIGURING_ENV_VARIABLES_FINISH,
    INIT_STATE_INIT_MESSAGE,
    INIT_STATE_MIRROR_PROP_SET,
    INIT_STATE_NO_ENV_VAR_CONFIGURED,
    INIT_STATE_NO_NODE_CONF_NEEDED,
    INIT_STATE_RELAY_LIMITS_DISABLED,
    INIT_STATE_START_DOCKER_CHECK,
    INIT_STATE_STARTING_MESSAGE,
    LOADING,
    NECESSARY_PORTS,
    NETWORK_NODE_CONFIG_DIR_PATH,
    OPTIONAL_PORTS
} from '../constants';
import os from 'os';
import packageJson from '../../package.json';
import { VerboseLevel } from '../types/VerboseLevel';

configDotenv({ path: path.resolve(__dirname, '../../.env') });

interface PackageMeta {
    version: string;
}
const LOCAL_NODE_VERSION: string = (packageJson as PackageMeta).version;

/**
 * Represents the initialization state of the application.
 * This state is responsible for setting up the necessary environment variables,
 * configuring node properties, and mirror node properties based on the selected configuration.
 */
export class InitState implements IState{
    /**
     * The logger service used for logging messages.
     */
    private logger: LoggerService;

    /**
     * The observer for the InitState.
     */
    private observer: IOBserver | undefined;

    /**
     * The CLI options for the initialization state.
     */
    private cliOptions: CLIOptions;

    /**
     * Represents the Docker service used by the InitState class.
     */
    private dockerService: DockerService;

    /**
     * The name of the state.
     */
    private stateName: string;
    
    /**
     * Initializes a new instance of the InitState class.
     */
    constructor() {
        this.stateName = InitState.name;
        this.logger = ServiceLocator.Current.get<LoggerService>(LoggerService.name);
        this.cliOptions = ServiceLocator.Current.get<CLIService>(CLIService.name).getCurrentArgv();
        this.dockerService = ServiceLocator.Current.get<DockerService>(DockerService.name);
        this.logger.trace(INIT_STATE_INIT_MESSAGE, this.stateName);
    }

    /**
     * Subscribes an observer to the state.
     * 
     * @param {IOBserver} observer - The observer to subscribe.
     */
    public subscribe(observer: IOBserver): void {
        this.observer = observer;
    }

    /**
     * Called when the state is started.
     * @returns {Promise<void>} A promise that resolves when the state has started.
     */
    public async onStart(): Promise<void> {
        this.printLogoAndVersion();
        this.logger.trace(INIT_STATE_STARTING_MESSAGE, this.stateName);
        const configurationData = ConfigurationData.getInstance();

        // Check if docker is running and it's the correct version
        this.logger.info(INIT_STATE_START_DOCKER_CHECK, this.stateName);
        const isCorrectDockerComposeVersion = await this.dockerService.isCorrectDockerComposeVersion();
        const isDockerStarted = await this.dockerService.checkDocker();
        const dockerHasEnoughResources = await this.dockerService.checkDockerResources(this.cliOptions.multiNode);
        const areNodeAndNpmVersionsValid = this.checkNodeAndNpmVersions();

        if (!(isCorrectDockerComposeVersion && isDockerStarted && dockerHasEnoughResources) && areNodeAndNpmVersionsValid) {
            this.observer!.update(EventType.UnresolvableError);
            return;
        }

        await this.dockerService.isPortInUse(NECESSARY_PORTS.concat(OPTIONAL_PORTS));

        this.logger.info(`${LOADING} Setting configuration with latest images on host ${this.cliOptions.host} with dev mode turned ${this.cliOptions.devMode ? 'on' : 'off'} using ${this.cliOptions.fullMode? 'full': 'turbo'} mode in ${this.cliOptions.multiNode? 'multi' : 'single'} node configuration...`, this.stateName);

        this.prepareWorkDirectory();
        const workDirConfiguration = [
            { key: 'NETWORK_NODE_LOGS_ROOT_PATH', value: join(this.cliOptions.workDir, 'network-logs', 'node') },
            { key: 'APPLICATION_CONFIG_PATH', value: join(this.cliOptions.workDir, 'compose-network', 'network-node', 'data', 'config') },
            { key: 'MIRROR_NODE_CONFIG_PATH', value: this.cliOptions.workDir },
        ];
        configurationData.envConfiguration = (configurationData.envConfiguration ?? []).concat(workDirConfiguration);
        
        this.configureEnvVariables(configurationData.imageTagConfiguration, configurationData.envConfiguration);
        this.configureNodeProperties(configurationData.nodeConfiguration?.properties);
        this.configureMirrorNodeProperties();

        this.observer!.update(EventType.Finish);
    }

    private checkNodeAndNpmVersions(): boolean {
        const MIN_NODE_VERSION = '17.9.1';
        const MIN_NPM_VERSION = '8.11.0';
        const V_OR_NEW_LINE_REGEX = /v|\n/g;

        const nodeVersion = shell.exec(`node -v `, { silent: true }).replace(V_OR_NEW_LINE_REGEX, '');
        const npmVersion = shell.exec(`npm -v `, { silent: true }).replace(V_OR_NEW_LINE_REGEX, '');

        const isNodeVersionValid = semver.gte(nodeVersion, MIN_NODE_VERSION);
        const isNpmVersionValid = semver.gte(npmVersion, MIN_NPM_VERSION);

        if (!isNodeVersionValid) {
            this.logger.error(`Current node version is ${nodeVersion} but minimum required one is ${MIN_NODE_VERSION}`);
        }
        if (!isNpmVersionValid) {
            this.logger.error(`Current npm version is ${npmVersion} but minimum required one is ${MIN_NPM_VERSION}`);
        }

        return isNodeVersionValid && isNpmVersionValid;
    }

    /**
     * Prepares the work directory.
     * 
     * This method logs the path to the work directory, creates ephemeral directories in the work directory, and defines the source paths for the config directory, the mirror node application YAML file, and the record parser.
     * It creates a map of the source paths to the destination paths in the work directory and copies the files from the source paths to the destination paths.
     * 
     * @private
     * @returns {void}
    */
    private prepareWorkDirectory() {
        this.logger.trace(`${CHECK_SUCCESS} Local Node Working directory set to ${this.cliOptions.workDir}.`, this.stateName);
        FileSystemUtils.createEphemeralDirectories(this.cliOptions.workDir);
        const configDirSource = join(__dirname, `../../${NETWORK_NODE_CONFIG_DIR_PATH}`);
        const configPathMirrorNodeSource = join(__dirname, `../../${APPLICATION_YML_RELATIVE_PATH}`);

        const configFiles = {
            [configDirSource]: `${this.cliOptions.workDir}/${NETWORK_NODE_CONFIG_DIR_PATH}`,
            [configPathMirrorNodeSource]: `${this.cliOptions.workDir}/${APPLICATION_YML_RELATIVE_PATH}`,
        };
        FileSystemUtils.copyPaths(configFiles);
    }

    /**
     * Configures the environment variables based on the selected configuration.
     * @param {Array<Configuration>} imageTagConfiguration - The image tag configuration.
     * @param {Array<Configuration> | undefined} envConfiguration - The environment variable configuration.
     */
    private configureEnvVariables(imageTagConfiguration: Array<Configuration>, envConfiguration: Array<Configuration> | undefined): void {
        imageTagConfiguration.forEach(variable => {
            const { tag, node } = this.extractImageTag(variable);
            this.logger.trace(`Environment variable ${node} will be set to ${tag}.`, this.stateName);
            process.env[node] = tag;
        });

        if (!envConfiguration) {
            this.logger.trace(INIT_STATE_NO_ENV_VAR_CONFIGURED, this.stateName);
            return;
        }

        envConfiguration!.forEach(variable => {
            process.env[variable.key] = variable.value;
            this.logger.trace(`Environment variable ${variable.key} will be set to ${variable.value}.`, this.stateName);
        });

        const relayLimitsDisabled = !this.cliOptions.limits;
        if (relayLimitsDisabled) {
            process.env.RELAY_HBAR_RATE_LIMIT_TINYBAR = '0';
            process.env.RELAY_HBAR_RATE_LIMIT_DURATION = '0';
            process.env.RELAY_RATE_LIMIT_DISABLED = `${relayLimitsDisabled}`;
            this.logger.info(INIT_STATE_RELAY_LIMITS_DISABLED, this.stateName);
        }
        this.logger.trace(INIT_STATE_CONFIGURING_ENV_VARIABLES_FINISH, this.stateName);

        // workaround for broken Java (21 to 23) on Apple Silicon M3/M4 chipsets under MacOS Sequoia when running inside docker
        // darwin release history can be found here https://en.wikipedia.org/wiki/Darwin_(operating_system)#Release_history
        if (os.platform() === "darwin" && os.release().slice(0, 2) === "24") {
            process.env.PLATFORM_JAVA_OPTS = "-XX:+UnlockExperimentalVMOptions -XX:UseSVE=0 -XX:+UseZGC -Xlog:gc*:gc.log";
            process.env.GRPC_PLATFORM_JAVA_OPTS = "-XX:UseSVE=0";
        }
    }

    /**
     * Extracts the image tag from the configuration.
     * 
     * @private
     * @param {Configuration} variable - The configuration.
     * @returns {string} The extracted image tag.
     */
    private extractImageTag(variable: Configuration): {
        tag: string,
        node: string
    } {
        const node = variable.key;
        let tag = variable.value;
        switch (node) {
            case "NETWORK_NODE_IMAGE_TAG":
            case "HAVEGED_IMAGE_TAG":
                if (this.cliOptions.networkTag) {
                    tag = this.cliOptions.networkTag;
                }
                break;
            case "MIRROR_IMAGE_TAG":
                if (this.cliOptions.mirrorTag) {
                    tag = this.cliOptions.mirrorTag;
                }
                break;
            case "RELAY_IMAGE_TAG":
                if (this.cliOptions.relayTag) {
                    tag = this.cliOptions.relayTag;
                }
                break;
            case "BLOCK_NODE_IMAGE_TAG":
                if (this.cliOptions.blockNodeTag) {
                    tag = this.cliOptions.blockNodeTag;
                }
                break;
        }

        return { 
            tag,
            node
        }
    }

    /**
     * Configures the node properties based on the selected configuration.
     * @param {Array<Configuration> | undefined} nodeConfiguration - The node configuration.
     */
    private configureNodeProperties(nodeConfiguration: Array<Configuration> | undefined): void {
        const propertiesFiles = ['bootstrap.properties', 'application.properties']
        for (let index = 0; index < propertiesFiles.length; index++) {
            const propertiesFilePath = join(this.cliOptions.workDir, NETWORK_NODE_CONFIG_DIR_PATH, propertiesFiles[index]);

            let newProperties = '';
            originalNodeConfiguration.bootsrapProperties.forEach(property => {
                newProperties = newProperties.concat(`${property.key}=${property.value}\n`);
            });

            if (!nodeConfiguration) {
                this.logger.trace(INIT_STATE_NO_NODE_CONF_NEEDED, this.stateName);
                return;
            }

            nodeConfiguration!.forEach(property => {
                newProperties = newProperties.concat(`${property.key}=${property.value}\n`);
                this.logger.trace(`Bootstrap property ${property.key} will be set to ${property.value}.`, this.stateName);
            });

            if (this.cliOptions.blockNode) {
                newProperties = newProperties.concat(`blockStream.writerMode=FILE_AND_GRPC\n`);
                this.logger.trace(`Bootstrap property blockStream.writerMode will be set to FILE_AND_GRPC.`, this.stateName);
            }

            writeFileSync(propertiesFilePath, newProperties, { flag: 'w' });

            this.logger.trace(INIT_STATE_BOOTSTRAPPED_PROP_SET, this.stateName);
        }
    }

    /**
     * Configures the mirror node properties.
     * 
     * @private
     */
    private configureMirrorNodeProperties(): void {
        this.logger.trace('Configuring required mirror node properties, depending on selected configuration...', this.stateName);
        const {fullMode, multiNode, persistTransactionBytes, workDir } = this.cliOptions;

        const propertiesFilePath = join(workDir, 'compose-network/mirror-node/application.yml');
        const application = yaml.load(readFileSync(propertiesFilePath).toString()) as any;

        if (!fullMode) {
            application.hedera.mirror.importer.dataPath = originalNodeConfiguration.turboNodeProperties.dataPath;
            application.hedera.mirror.importer.downloader.sources = originalNodeConfiguration.turboNodeProperties.sources;
        }

        if (multiNode) {
            application.hedera.mirror.monitor.nodes = originalNodeConfiguration.multiNodeProperties;
            process.env.RELAY_HEDERA_NETWORK = '{"network-node:50211":"0.0.3","network-node-1:50211":"0.0.4","network-node-2:50211":"0.0.5","network-node-3:50211":"0.0.6"}';
        }

        if (persistTransactionBytes) {
            application.hedera.mirror.importer.parser.record.entity.persist.transactionBytes = true;
            application.hedera.mirror.importer.parser.record.entity.persist.transactionRecordBytes = true;
        }

        writeFileSync(propertiesFilePath, yaml.dump(application, { lineWidth: 256 }));
        this.logger.trace(INIT_STATE_MIRROR_PROP_SET, this.stateName);
    }

    /**
     * Prints the Hiero Local-Node logo and version information.
     * @private
     */
    private printLogoAndVersion(): void {
        const logo = `
                         ██╗  ██╗██╗███████╗██████╗  ██████╗ 
                         ██║  ██║██║██╔════╝██╔══██╗██╔═══██╗
                         ███████║██║█████╗  ██████╔╝██║   ██║
                         ██╔══██║██║██╔══╝  ██╔══██╗██║   ██║
                         ██║  ██║██║███████╗██║  ██║╚██████╔╝
                         ╚═╝  ╚═╝╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝
                                          
    ██╗      ██████╗  ██████╗ █████╗ ██╗        ███╗   ██╗ ██████╗ ██████╗ ███████╗
    ██║     ██╔═══██╗██╔════╝██╔══██╗██║        ████╗  ██║██╔═══██╗██╔══██╗██╔════╝
    ██║     ██║   ██║██║     ███████║██║        ██╔██╗ ██║██║   ██║██║  ██║█████╗  
    ██║     ██║   ██║██║     ██╔══██║██║        ██║╚██╗██║██║   ██║██║  ██║██╔══╝  
    ███████╗╚██████╔╝╚██████╗██║  ██║███████╗   ██║ ╚████║╚██████╔╝██████╔╝███████╗
    ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝   ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚══════╝
    `;

        const versionInfo = `    Local-Node Version: ${LOCAL_NODE_VERSION}`;
        const divider = `    ─────────────────────────────────────────────`;
        const nodesVersionDivider = `
${divider}
    Hiero Nodes Version
${divider}`;

        const configurationData = ConfigurationData.getInstance();
        const nodeVersions = configurationData.imageTagConfiguration
            .reduce((acc, variable) => {
                const { tag, node } = this.extractImageTag(variable);
                let nodeName = '';
                switch (node) {
                    case "NETWORK_NODE_IMAGE_TAG":
                        nodeName = "Consensus Node";
                        break;
                    case "MIRROR_IMAGE_TAG":
                        nodeName = "Mirror Node";
                        break;
                    case "RELAY_IMAGE_TAG":
                        nodeName = "Relay";
                        break;
                    case "BLOCK_NODE_IMAGE_TAG":
                        nodeName = "Block Node";
                        break;
                    case "MIRROR_NODE_EXPLORER_IMAGE_TAG":
                        nodeName = "Mirror Node Explorer";
                        break;
                    default:
                        return acc;
                }
                // Only add if we haven't seen this node type before
                if (!acc.some(item => item.startsWith(nodeName))) {
                    acc.push(`    ${nodeName} Version: ${tag}`);
                }
                return acc;
            }, [] as Array<string>)
            .join('\n');

        const configStatusDivider = `
${divider}
    Configuration Status
${divider}`;

        const configStatus = [
            `    Node Configuration: ${this.cliOptions.multiNode ? 'Multi' : 'Single'} Node`,
            `    Block Node: ${this.cliOptions.blockNode ? 'Enabled' : 'Disabled'}`,
            `    Host: ${this.cliOptions.host}`,
            `    Verbose Level: ${VerboseLevel[this.cliOptions.verbose]}`
        ].join('\n');
        
        console.log(logo);
        console.log(versionInfo);   
        console.log(nodesVersionDivider);
        console.log(nodeVersions);
        console.log(divider);
        console.log(configStatusDivider);
        console.log(configStatus);
        console.log(divider);
        console.log();
    }
}
