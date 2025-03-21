import axios from "./axios.js";
import { getAuthToken } from "../utils/accounts.js";
import { BACKEND_ENDPOINT } from "../constants.js";
import version from "../utils/version.js";
import { ProjectDetails, StatusOk } from "./models.js";
import { AxiosResponse } from "axios";
import { GENEZIO_NOT_AUTH_ERROR_MSG, UserError } from "../errors.js";

export default async function getProjectInfo(projectId: string): Promise<ProjectDetails> {
    const authToken = await getAuthToken();
    if (!authToken) {
        throw new UserError(GENEZIO_NOT_AUTH_ERROR_MSG);
    }

    const response: AxiosResponse<StatusOk<{ project: ProjectDetails }>> = await axios({
        method: "GET",
        url: `${BACKEND_ENDPOINT}/projects/${projectId}`,
        headers: {
            Authorization: `Bearer ${authToken}`,
            "Accept-Version": `genezio-cli/${version}`,
        },
    });

    return response.data.project;
}

export async function getProjectEnvFromProject(projectId: string, stageName: string) {
    const completeProjectInfo = await getProjectInfo(projectId);
    const projectEnv = completeProjectInfo.projectEnvs.find(
        (projectEnv) => projectEnv.name == stageName,
    );

    return projectEnv;
}
