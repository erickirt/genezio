import axios from "./axios.js";
import { getAuthToken } from "../utils/accounts.js";
import { BACKEND_ENDPOINT } from "../constants.js";
import version from "../utils/version.js";
import { AxiosResponse } from "axios";
import { StatusOk } from "./models.js";
import { GENEZIO_NOT_AUTH_ERROR_MSG, UserError } from "../errors.js";

export async function getCompileDartPresignedURL(archiveName: string) {
    if (!archiveName) {
        throw new UserError("Missing required parameters");
    }

    // Check if user is authenticated
    const authToken = await getAuthToken();
    if (!authToken) {
        throw new UserError(GENEZIO_NOT_AUTH_ERROR_MSG);
    }

    const json = JSON.stringify({
        zipName: archiveName,
    });

    const response: AxiosResponse<StatusOk<{ userId: string; presignedURL: string | undefined }>> =
        await axios({
            method: "GET",
            url: `${BACKEND_ENDPOINT}/core/compile-dart-url`,
            data: json,
            headers: {
                Authorization: `Bearer ${authToken}`,
                "Accept-Version": `genezio-cli/${version}`,
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

    if (response.data.presignedURL === undefined) {
        throw new UserError("The endpoint did not return a presigned url.");
    }

    return { ...response.data, presignedURL: response.data.presignedURL };
}
