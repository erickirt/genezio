import path from "path";
import { UserError } from "../../errors.js";
import { CloudProviderIdentifier } from "../../models/cloudProviderIdentifier.js";
import {
    AuthDatabaseConfig,
    AuthenticationProviders,
    AuthProviderDetails,
    CreateDatabaseRequest,
    GetDatabaseResponse,
    SetAuthenticationRequest,
    SetAuthProvidersRequest,
    YourOwnAuthDatabaseConfig,
} from "../../models/requests.js";
import { DatabaseType } from "../../projectConfiguration/yaml/models.js";
import { YamlProjectConfiguration } from "../../projectConfiguration/yaml/v2.js";
import {
    createDatabase,
    findLinkedDatabase,
    getDatabaseByName,
    linkDatabaseToEnvironment,
} from "../../requests/database.js";
import { DASHBOARD_URL } from "../../constants.js";
import getProjectInfoByName from "../../requests/getProjectInfoByName.js";
import { createEmptyProject } from "../../requests/project.js";
import { debugLogger } from "../../utils/logging.js";
import { parseRawVariable, resolveConfigurationVariable } from "../../utils/scripts.js";
import { fileExists, readEnvironmentVariablesFile } from "../../utils/file.js";
import { GenezioTelemetry, TelemetryEventTypes } from "../../telemetry/telemetry.js";
import { setEnvironmentVariables } from "../../requests/setEnvironmentVariables.js";
import { log } from "../../utils/logging.js";
import { AxiosError } from "axios";
import colors from "colors";
import {
    detectEnvironmentVariablesFile,
    findAnEnvFile,
    getUnsetEnvironmentVariables,
    parseConfigurationVariable,
    promptToConfirmSettingEnvironmentVariables,
    resolveEnvironmentVariable,
} from "../../utils/environmentVariables.js";
import { EnvironmentVariable } from "../../models/environmentVariables.js";
import { isCI } from "../../utils/process.js";
import {
    getAuthProviders,
    setAuthentication,
    setAuthProviders,
} from "../../requests/authentication.js";

export async function getOrCreateEmptyProject(
    projectName: string,
    region: string,
    stage: string = "prod",
): Promise<{ projectId: string; projectEnvId: string }> {
    const project = await getProjectInfoByName(projectName).catch((error) => {
        if (error instanceof UserError && error.message.includes("record not found")) {
            return undefined;
        }
        debugLogger.debug(`Error getting project ${projectName}: ${error}`);
        throw new UserError(`Failed to get project ${projectName}.`);
    });

    if (!project) {
        const newProject = await createEmptyProject({
            projectName: projectName,
            region: region,
            cloudProvider: CloudProviderIdentifier.GENEZIO_CLOUD,
            stage: stage,
        }).catch((error) => {
            debugLogger.debug(`Error creating project ${projectName}: ${error}`);
            throw new UserError(`Failed to create project ${projectName}.`);
        });

        debugLogger.debug(
            `Project ${projectName} in region ${region} on stage ${stage} was created successfully`,
        );

        return { projectId: newProject.projectId, projectEnvId: newProject.projectEnvId };
    }

    const projectEnv = project.projectEnvs.find((projectEnv) => projectEnv.name == stage);
    if (!projectEnv) {
        throw new UserError(`Stage ${stage} not found in project ${projectName}.`);
    }

    return { projectId: project.id, projectEnvId: projectEnv.id };
}

export async function getOrCreateDatabase(
    createDatabaseReq: CreateDatabaseRequest,
    stage: string,
    projectId: string,
    projectEnvId: string,
): Promise<GetDatabaseResponse> {
    const database = await getDatabaseByName(createDatabaseReq.name);
    if (database) {
        debugLogger.debug(`Database ${createDatabaseReq.name} is already created.`);

        const linkedDatabase = await findLinkedDatabase(
            createDatabaseReq.name,
            projectId,
            projectEnvId,
        ).catch((error) => {
            debugLogger.debug(`Error finding linked database ${createDatabaseReq.name}: ${error}`);
            throw new UserError(`Failed to find linked database ${createDatabaseReq.name}.`);
        });

        if (linkedDatabase) {
            debugLogger.debug(
                `Database ${createDatabaseReq.name} is already linked to stage ${stage}`,
            );
            return linkedDatabase;
        }
        await linkDatabaseToEnvironment(projectId, projectEnvId, database.id).catch((error) => {
            debugLogger.debug(`Error linking database ${createDatabaseReq.name}: ${error}`);
            throw new UserError(`Failed to link database ${createDatabaseReq.name}.`);
        });

        debugLogger.debug(
            `Database ${createDatabaseReq.name} was linked successfully to stage ${stage}`,
        );
        return database;
    }

    const newDatabase = await createDatabase(
        createDatabaseReq,
        projectId,
        projectEnvId,
        true,
    ).catch((error) => {
        debugLogger.debug(`Error creating database ${createDatabaseReq.name}: ${error}`);
        throw new UserError(`Failed to create database ${createDatabaseReq.name}.`);
    });
    debugLogger.debug(`Database ${createDatabaseReq.name} created successfully`);
    return {
        id: newDatabase.databaseId,
        name: createDatabaseReq.name,
        region: createDatabaseReq.region,
        type: createDatabaseReq.type || DatabaseType.neon,
    };
}

function isYourOwnAuthDatabaseConfig(object: unknown): object is YourOwnAuthDatabaseConfig {
    return typeof object === "object" && object !== null && "uri" in object && "type" in object;
}

export async function enableAuthentication(
    configuration: YamlProjectConfiguration,
    projectId: string,
    projectEnvId: string,
    stage: string,
    envFile: string | undefined,
) {
    const authDatabase = configuration.services?.authentication?.database as AuthDatabaseConfig;
    if (!authDatabase) {
        return;
    }

    const authProviders = configuration.services?.authentication
        ?.providers as AuthenticationProviders;

    if (isYourOwnAuthDatabaseConfig(authDatabase)) {
        const databaseUri = await evaluateResource(configuration, authDatabase.uri, stage, envFile);

        await enableAuthenticationHelper(
            {
                enabled: true,
                databaseUri: databaseUri,
                databaseType: authDatabase.type,
            },
            projectEnvId,
            authProviders,
        );
    } else {
        const database: GetDatabaseResponse = await getOrCreateDatabase(
            {
                name: authDatabase.name,
                region: authDatabase.region,
                type: authDatabase.type,
            },
            stage,
            projectId,
            projectEnvId,
        );

        await enableAuthenticationHelper(
            {
                enabled: true,
                databaseUri: database.connectionUrl || "",
                databaseType: database.type,
            },
            projectEnvId,
            authProviders,
        );
    }
}
export async function enableAuthenticationHelper(
    request: SetAuthenticationRequest,
    projectEnvId: string,
    providers?: AuthenticationProviders,
): Promise<void> {
    await setAuthentication(projectEnvId, request);

    const authProvidersResponse = await getAuthProviders(projectEnvId);

    const providersDetails: AuthProviderDetails[] = [];

    if (providers) {
        for (const provider of authProvidersResponse.authProviders) {
            let enabled = false;
            switch (provider.name) {
                case "email":
                    if (providers.email) {
                        enabled = true;
                    }
                    providersDetails.push({
                        id: provider.id,
                        name: provider.name,
                        enabled: enabled,
                        config: null,
                    });
                    break;
                case "web3":
                    if (providers.web3) {
                        enabled = true;
                    }
                    providersDetails.push({
                        id: provider.id,
                        name: provider.name,
                        enabled: enabled,
                        config: null,
                    });
                    break;
                case "google":
                    if (providers.google) {
                        enabled = true;
                    }
                    providersDetails.push({
                        id: provider.id,
                        name: provider.name,
                        enabled: enabled,
                        config: {
                            GNZ_AUTH_GOOGLE_ID: providers.google?.clientId || "",
                            GNZ_AUTH_GOOGLE_SECRET: providers.google?.clientSecret || "",
                        },
                    });
                    break;
            }
        }

        // If providers details are updated, call the setAuthProviders method
        if (providersDetails.length > 0) {
            const setAuthProvidersRequest: SetAuthProvidersRequest = {
                authProviders: providersDetails,
            };
            await setAuthProviders(projectEnvId, setAuthProvidersRequest);
        }
    }

    return;
}

export async function evaluateResource(
    configuration: YamlProjectConfiguration,
    resource: string | undefined,
    stage: string,
    envFile: string | undefined,
): Promise<string> {
    if (!resource) {
        return "";
    }

    const resourceRaw = await parseConfigurationVariable(resource);

    if ("path" in resourceRaw && "field" in resourceRaw) {
        const resourceValue = await resolveConfigurationVariable(
            configuration,
            stage,
            resourceRaw.path,
            resourceRaw.field,
        );

        return resourceValue;
    }

    if ("key" in resourceRaw) {
        if (!envFile) {
            throw new UserError(
                `Environment variable file ${envFile} is missing. Please provide the correct path with genezio deploy --env <envFile>.`,
            );
        }
        const resourceValue = (await readEnvironmentVariablesFile(envFile)).find(
            (envVar) => envVar.name === resourceRaw.key,
        )?.value;

        if (!resourceValue) {
            throw new UserError(
                `Environment variable ${resourceRaw.key} is missing from the ${envFile} file.`,
            );
        }

        return resourceValue;
    }

    return resourceRaw.value;
}

export async function processYamlEnvironmentVariables(
    environment: Record<string, string>,
    configuration: YamlProjectConfiguration,
    stage: string,
    options?: {
        isLocal?: boolean;
        port?: number;
    },
): Promise<Record<string, string>> {
    const newEnvObject: Record<string, string> = {};

    for (const [key, rawValue] of Object.entries(environment)) {
        const variable = await parseRawVariable(rawValue);

        if (!variable) {
            debugLogger.debug(
                `The key ${key} with value ${rawValue} does not contain a variable with the format $\{{<variable>}}. The raw value is being set.`,
            );
            newEnvObject[key] = rawValue;
        } else {
            const resolvedValue = await resolveConfigurationVariable(
                configuration,
                stage,
                variable?.path,
                variable?.field,
                options,
            );
            debugLogger.debug(
                `The key ${key} with value ${rawValue} contains a variable with the format $\{{<variable>}}. The evaluated value ${resolvedValue} is being set.`,
            );
            newEnvObject[key] = resolvedValue;
        }
    }

    return newEnvObject;
}

export async function uploadEnvVarsFromFile(
    envPath: string | undefined,
    projectId: string,
    projectEnvId: string,
    cwd: string,
    stage: string,
    configuration: YamlProjectConfiguration,
) {
    if (envPath) {
        const envFile = path.join(process.cwd(), envPath);
        debugLogger.debug(`Loading environment variables from ${envFile}.`);

        if (!(await fileExists(envFile))) {
            // There is no need to exit the process here, as the project has been deployed
            log.error(`File ${envFile} does not exists. Please provide the correct path.`);
            await GenezioTelemetry.sendEvent({
                eventType: TelemetryEventTypes.GENEZIO_DEPLOY_ERROR,
                errorTrace: `File ${envFile} does not exists`,
            });
        } else {
            // Read environment variables from .env file
            const envVars = await readEnvironmentVariablesFile(envFile);

            // Upload environment variables to the project
            await setEnvironmentVariables(projectId, projectEnvId, envVars)
                .then(async () => {
                    const envVarKeys = envVars.map((envVar) => envVar.name);
                    log.info(
                        `The following environment variables ${envVarKeys.join(", ")} were uploaded to the project successfully.`,
                    );
                    await GenezioTelemetry.sendEvent({
                        eventType: TelemetryEventTypes.GENEZIO_DEPLOY_LOAD_ENV_VARS,
                    });
                })
                .catch(async (error: AxiosError) => {
                    log.error(`Loading environment variables failed with: ${error.message}`);
                    log.error(
                        `Try to set the environment variables using the dashboard ${colors.cyan(
                            DASHBOARD_URL,
                        )}`,
                    );
                    await GenezioTelemetry.sendEvent({
                        eventType: TelemetryEventTypes.GENEZIO_DEPLOY_ERROR,
                        errorTrace: error.toString(),
                    });
                });
        }
    }

    // This is best effort, we should encourage the user to use `--env <envFile>` to set the correct env file path.
    // Search for possible .env files in the project directory and use the first
    const envFile = envPath ? path.join(process.cwd(), envPath) : await findAnEnvFile(cwd);

    if (!envFile) {
        return;
    }

    const envVars = await readEnvironmentVariablesFile(envFile);
    const missingEnvVars = await getUnsetEnvironmentVariables(
        envVars.map((envVar) => envVar.name),
        projectId,
        projectEnvId,
    );

    const environment = configuration.backend?.environment;
    if (environment) {
        const unsetEnvVarKeys = await getUnsetEnvironmentVariables(
            Object.keys(environment),
            projectId,
            projectEnvId,
        );

        const environmentVariablesToBePushed: EnvironmentVariable[] = (
            await Promise.all(
                unsetEnvVarKeys.map(async (envVarKey) => {
                    const variable = await parseConfigurationVariable(environment[envVarKey]);
                    const resolvedVariable = await resolveEnvironmentVariable(
                        configuration,
                        variable,
                        envVarKey,
                        envFile,
                        stage,
                    );
                    if (!resolvedVariable) {
                        return undefined;
                    }
                    return resolvedVariable;
                }),
            )
        ).filter((item): item is EnvironmentVariable => item !== undefined);

        if (environmentVariablesToBePushed.length > 0) {
            debugLogger.debug(
                `Uploading environment variables ${JSON.stringify(environmentVariablesToBePushed)} from ${envFile} to project ${projectId}`,
            );
            await setEnvironmentVariables(projectId, projectEnvId, environmentVariablesToBePushed);
            debugLogger.debug(
                `Environment variables uploaded to project ${projectId} successfully.`,
            );
        }

        return;
    }

    if (!isCI() && missingEnvVars.length > 0 && (await detectEnvironmentVariablesFile(envFile))) {
        debugLogger.debug(`Attempting to upload ${missingEnvVars.join(", ")} from ${envFile}.`);

        // Interactively prompt the user to confirm setting environment variables
        const confirmSettingEnvVars =
            await promptToConfirmSettingEnvironmentVariables(missingEnvVars);

        if (!confirmSettingEnvVars) {
            log.info(
                `Skipping environment variables upload. You can set them later by navigation to the dashboard ${DASHBOARD_URL}`,
            );
        } else {
            const environmentVariablesToBePushed = envVars.filter((envVar: { name: string }) =>
                missingEnvVars.includes(envVar.name),
            );

            debugLogger.debug(
                `Uploading environment variables ${JSON.stringify(environmentVariablesToBePushed)} from ${envFile} to project ${projectId}`,
            );
            await setEnvironmentVariables(
                projectId,
                projectEnvId,
                environmentVariablesToBePushed,
            ).then(async () => {
                const envVarKeys = envVars.map((envVar) => envVar.name);
                log.info(
                    `The following environment variables ${envVarKeys.join(", ")} were uploaded to the project successfully.`,
                );
                await GenezioTelemetry.sendEvent({
                    eventType: TelemetryEventTypes.GENEZIO_DEPLOY_LOAD_ENV_VARS,
                });
            });
            debugLogger.debug(
                `Environment variables uploaded to project ${projectId} successfully.`,
            );
        }
    } else if (missingEnvVars.length > 0) {
        log.warn(
            `Environment variables ${missingEnvVars.join(", ")} are not set remotely. Please set them using the dashboard ${colors.cyan(
                DASHBOARD_URL,
            )}`,
        );
    }
}
