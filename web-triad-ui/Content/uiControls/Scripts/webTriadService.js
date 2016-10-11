class WebTriadService {
    //////////////////////////////////////////////////////////////////////////
    constructor(serviceSettings) {
        this.self = this;
        this.fileApiUrl = "/files";
        this.dicomViewerUrl = "/dicomViewerUrl";
        this.anonymizationProfileUrl = "/anonymizationProfile";
        this.submissionFileInfoApiUrl = "/submissionPackages";
        this.submittedSeriesDetailsUrl = "/series";
        this.submittedStudiesDetailsUrl = "/studies";
        this.submittedFilesDetailsUrl = "/submittedPackageFiles";
        this.settings = $.extend({
            serverApiUrl: "http://cuv-triad-app.restonuat.local/api",
            numberOfFilesInPackage: 4,
            sizeChunk: 1024 * 1024 * 2,
            numberOfConnection: 6
        }, serviceSettings);
        const serverApiUrl = this.settings.serverApiUrl;
        this.fileApiUrl = serverApiUrl + this.fileApiUrl;
        this.submissionFileInfoApiUrl = serverApiUrl + this.submissionFileInfoApiUrl;
        this.submittedStudiesDetailsUrl = serverApiUrl + this.submittedStudiesDetailsUrl;
        this.submittedSeriesDetailsUrl = serverApiUrl + this.submittedSeriesDetailsUrl;
        this.submittedFilesDetailsUrl = serverApiUrl + this.submittedFilesDetailsUrl;
        this.dicomViewerUrl = serverApiUrl + this.dicomViewerUrl;
        this.anonymizationProfileUrl = serverApiUrl + this.anonymizationProfileUrl;
        this.listsOfFiles = {};
    }
    ////////////////////////////////////////////
    submitFiles(files, metadata, uploadAndSubmitListOfFilesProgress) {
        var id = this.addListOfFilesForUpload(files);
        var isd = this.isDicom(files[0]);
        $.when(isd).done((isDicom) => {
            this.listsOfFiles[id].isDicom = isDicom;
            var data = {
                listOfFilesId: id
            };
            uploadAndSubmitListOfFilesProgress(data);
            this.uploadAndSubmitListOfFiles(id, metadata, uploadAndSubmitListOfFilesProgress);
        });
    }
    ////////////////////////////////////////////
    addListOfFilesForUpload(files) {
        const listOfFilesId = this.getGuid();
        this.listsOfFiles[listOfFilesId] = {
            files: [],
            transactionUid: null,
            size: 0,
            receiptTransactionUid: $.Deferred(),
            isCanceled: false,
            submits: [],
            isDicom: false
        };
        if (files.length > 0) {
            let sizeOfFiles = 0;
            for (let i = 0; i < files.length; i++) {
                files[i].number = i;
                files[i].listOfFilesId = listOfFilesId;
                this.setFileStatus(files[i], FileStatus.Ready);
                this.listsOfFiles[listOfFilesId].files.push(files[i]);
                sizeOfFiles += files[i].size;
            }
            this.listsOfFiles[listOfFilesId].size = sizeOfFiles;
        }
        return listOfFilesId;
    }
    ////////////////////////////////////////////
    uploadAndSubmitListOfFiles(listOfFilesId, metadata, uploadAndSubmitListOfFilesProgress) {
        var self = this;
        var listOfFiles = self.listsOfFiles[listOfFilesId];
        var startFileNumberInPackage = 0;
        var finishFileNumberInPackage = 0;
        var numberOfUploadedBytes = 0;
        var additionalSubmitTransactionUid;
        var transactionUid = null;
        var data = {};
        data.listOfFilesId = listOfFilesId;
        var currentPackage = new PackageOfFilesForUpload();
        var typeOfSubmit = TypeOfSubmit.CreateSubmissionPackage;
        for (let i = 0; i < metadata.length; i++) {
            if (metadata[i].Name === "TypeOfSubmit") {
                typeOfSubmit = metadata[i].Value;
                break;
            }
        }
        if (typeOfSubmit !== TypeOfSubmit.CreateSubmissionPackage) {
            transactionUid = self.getGuid();
            listOfFiles.transactionUid = transactionUid;
            listOfFiles.receiptTransactionUid.resolve().promise();
        }
        if (typeOfSubmit === TypeOfSubmit.AddDicomFilesToExistingSubmissionPackage) {
            for (let i = 0; i < metadata.length; i++) {
                if (metadata[i].Name === "AdditionalSubmitTransactionUID") {
                    additionalSubmitTransactionUid = metadata[i].Value;
                    break;
                }
            }
        }
        processingNextPackage();
        function processingNextPackage() {
            currentPackage.files = getNextFilesForPackage();
            if (currentPackage.files.length === 0)
                return;
            currentPackage.numberOfFiles = currentPackage.files.length;
            currentPackage.numberOfUploadedFiles = 0;
            currentPackage.packageSize = self.getSizeOfListFiles(currentPackage.files);
            currentPackage.urisOfUploadedFiles = [];
            uploadNextFileFromPackage();
        }
        function uploadNextFileFromPackage() {
            if (listOfFiles.isCanceled)
                return;
            const file = currentPackage.files.splice(0, 1)[0];
            self.uploadFile(file, uploadFileProgress);
        }
        function getNextFilesForPackage() {
            startFileNumberInPackage = finishFileNumberInPackage;
            finishFileNumberInPackage += self.settings.numberOfFilesInPackage;
            return listOfFiles.files.slice(startFileNumberInPackage, finishFileNumberInPackage);
        }
        function uploadFileProgress(uploadData) {
            ////data.uploadFileData = uploadData;
            switch (uploadData.status) {
                case ProcessStatus.Success:
                    if (listOfFiles.isCanceled) {
                        data.status = ProcessStatus.Success;
                        data.message = "CancelSubmit";
                        data.progress = 0;
                        data.progressBytes = 0;
                        uploadAndSubmitListOfFilesProgress(data);
                        return;
                    }
                    numberOfUploadedBytes += uploadData.blockSize;
                    data.status = ProcessStatus.InProgress;
                    data.message = "InProgress";
                    data.progress = Math.ceil(numberOfUploadedBytes / listOfFiles.size * 100);
                    data.progressBytes = numberOfUploadedBytes;
                    currentPackage.urisOfUploadedFiles.push(uploadData.fileUri);
                    currentPackage.numberOfUploadedFiles++;
                    if (currentPackage.numberOfUploadedFiles === currentPackage.numberOfFiles) {
                        const parameters = {
                            FileUris: currentPackage.urisOfUploadedFiles,
                            Metadata: metadata
                        };
                        listOfFiles.submits.push($.Deferred());
                        switch (typeOfSubmit) {
                            case TypeOfSubmit.CreateSubmissionPackage:
                                self.createSubmissionPackage(parameters, submitFilesProgress);
                                break;
                            case TypeOfSubmit.AddDicomFilesToExistingSubmissionPackage:
                                data.transactionUid = transactionUid;
                                parameters.Metadata = [
                                    new ItemData("TransactionUID", transactionUid)
                                ];
                                self.addDicomFilesToExistingSubmissionPackage(additionalSubmitTransactionUid, parameters, submitFilesProgress);
                                break;
                            case TypeOfSubmit.AddNonDicomFilesToExistingSubmissionPackage:
                                data.transactionUid = transactionUid;
                                parameters.Metadata.push(new ItemData("TransactionUID", transactionUid));
                                self.addNonDicomFilesToExistingSubmissionPackage(parameters, submitFilesProgress);
                                break;
                            default:
                        }
                        return;
                    }
                    uploadAndSubmitListOfFilesProgress(data);
                    uploadNextFileFromPackage();
                    break;
                case ProcessStatus.InProgress:
                    numberOfUploadedBytes += uploadData.blockSize;
                    data.status = ProcessStatus.InProgress;
                    data.message = "InProgress";
                    data.progress = Math.ceil(numberOfUploadedBytes / listOfFiles.size * 100);
                    data.progressBytes = numberOfUploadedBytes;
                    uploadAndSubmitListOfFilesProgress(data);
                    break;
                case ProcessStatus.Error:
                    data.status = ProcessStatus.Error;
                    data.message = "Error";
                    uploadAndSubmitListOfFilesProgress(data);
                    break;
                default:
            }
        }
        function submitFilesProgress(submitData) {
            ///data.submitFilesData = submitData;
            if (typeOfSubmit === TypeOfSubmit.CreateSubmissionPackage) {
                transactionUid = submitData.transactionUid;
                listOfFiles.transactionUid = transactionUid;
                data.transactionUid = transactionUid;
                typeOfSubmit = TypeOfSubmit.AddDicomFilesToExistingSubmissionPackage;
                additionalSubmitTransactionUid = submitData.submissionPackageUid;
            }
            if (!listOfFiles.isDicom) {
                typeOfSubmit = TypeOfSubmit.CreateSubmissionPackage;
            }
            const def = listOfFiles.submits.pop().resolve().promise();
            listOfFiles.submits.push(def);
            switch (submitData.status) {
                case ProcessStatus.Success:
                    listOfFiles.receiptTransactionUid.resolve().promise();
                    if (finishFileNumberInPackage < listOfFiles.files.length) {
                        data.status = ProcessStatus.InProgress;
                        data.message = "InProgress";
                        uploadAndSubmitListOfFilesProgress(data);
                        processingNextPackage();
                        return;
                    }
                    data.test = numberOfUploadedBytes + "///" + listOfFiles.size;
                    data.status = ProcessStatus.Success;
                    data.message = "Success";
                    uploadAndSubmitListOfFilesProgress(data);
                    break;
                case ProcessStatus.Error:
                    data.status = ProcessStatus.Error;
                    data.message = "Error";
                    uploadAndSubmitListOfFilesProgress(data);
                    break;
                default:
            }
        }
    }
    ////////////////////////////
    createSubmissionPackage(parameters, submitFilesProgress) {
        var data = {};
        $.ajax({
            url: this.submissionFileInfoApiUrl,
            type: "PUT",
            contentType: "application/json; charset=utf-8",
            data: JSON.stringify(parameters),
            error(jqXhr) {
                data.status = ProcessStatus.Error;
                data.message = "Error Submit";
                data.details = jqXhr.responseText;
                data.errorCode = jqXhr.status;
                submitFilesProgress(data);
            },
            success(result, textStatus, jqXhr) {
                const url = jqXhr.getResponseHeader("Location");
                data.submissionPackageUid = url;
                data.transactionUid = url;
                data.status = ProcessStatus.Success;
                data.message = "Success Submit";
                submitFilesProgress(data);
            }
        });
    }
    ////////////////////////////
    addDicomFilesToExistingSubmissionPackage(uri, parameters, additionalSubmitFilesProgress) {
        let isContainsTransactionUid = false;
        for (let i = 0; i < parameters.Metadata.length; i++) {
            if (parameters.Metadata[i].Name === "TransactionUID") {
                isContainsTransactionUid = true;
                break;
            }
        }
        if (!isContainsTransactionUid) {
            parameters.Metadata.push({
                Name: "TransactionUID",
                Value: this.getGuid()
            });
        }
        var data = {};
        $.ajax({
            url: this.submissionFileInfoApiUrl + "/" + uri,
            type: "POST",
            contentType: "application/json; charset=utf-8",
            data: JSON.stringify(parameters),
            error(jqXhr) {
                data.status = ProcessStatus.Error;
                data.message = "Error additionalSubmit";
                data.details = jqXhr.responseText;
                data.errorCode = jqXhr.status;
                additionalSubmitFilesProgress(data);
            },
            success() {
                data.status = ProcessStatus.Success;
                data.message = "Success additionalSubmit";
                additionalSubmitFilesProgress(data);
            }
        });
    }
    ////////////////////////////
    addNonDicomFilesToExistingSubmissionPackage(parameters, submitFilesProgress) {
        let isContainsTransactionUid = false;
        for (let i = 0; i < parameters.Metadata.length; i++) {
            if (parameters.Metadata[i].Name === "TransactionUID") {
                isContainsTransactionUid = true;
                break;
            }
        }
        if (!isContainsTransactionUid) {
            parameters.Metadata.push({
                Name: "TransactionUID",
                Value: this.getGuid()
            });
        }
        var data = {};
        $.ajax({
            url: this.submissionFileInfoApiUrl,
            type: "POST",
            contentType: "application/json; charset=utf-8",
            data: JSON.stringify(parameters),
            error(jqXhr) {
                data.status = ProcessStatus.Error;
                data.message = "Error attachFiles";
                data.details = jqXhr.responseText;
                data.errorCode = jqXhr.status;
                submitFilesProgress(data);
            },
            success() {
                data.status = ProcessStatus.Success;
                data.message = "Success attachFiles";
                submitFilesProgress(data);
            }
        });
    }
    //////////////////////////////
    cancelUploadAndSubmitListOfFiles(listOfFilesId, cancelSubmitProgress) {
        const self = this;
        var listOfFiles = self.listsOfFiles[listOfFilesId];
        var data = {};
        data.listOfFilesId = listOfFilesId;
        listOfFiles.isCanceled = true;
        $.when.apply($, listOfFiles.submits).done(() => {
            for (let i = 0; i < listOfFiles.files.length; i++) {
                if (listOfFiles.files[i].status === FileStatus.Uploaded) {
                    listOfFiles.files[i].status = FileStatus.Canceling;
                    listOfFiles.files[i].cancelUploadFileProgress = cancelSubmitProgress;
                    this.deleteFileFromStage(listOfFiles.files[i]);
                }
            }
            $.when(listOfFiles.receiptTransactionUid).done(() => {
                $.ajax({
                    url: this.submissionFileInfoApiUrl + "/" + listOfFiles.transactionUid,
                    type: "DELETE",
                    error(jqXhr, textStatus, errorThrown) {
                        data.status = ProcessStatus.Error;
                        data.message = "Error cancelSubmit";
                        data.details = jqXhr.responseText;
                        data.errorCode = jqXhr.status;
                        cancelSubmitProgress(data);
                    },
                    success(result, textStatus, jqXhr) {
                        data.status = ProcessStatus.Success;
                        data.message = "Success cancelSubmit";
                        cancelSubmitProgress(data);
                    }
                });
            });
        });
    }
    /////////////////////////////////////////
    getStudiesDetails(parameters, callback) {
        parameters = this.arrayOfNameValueToDictionary(parameters);
        $.ajax({
            url: this.submittedStudiesDetailsUrl + "?" + $.param(parameters),
            type: "GET",
            dataType: "json",
            error(jqXhr, textStatus, errorThrown) {
                let data = {};
                data.status = ProcessStatus.Error;
                data.message = jqXhr.responseText;
                callback(data);
            },
            success(data, textStatus, jqXhr) {
                data.status = ProcessStatus.Success;
                callback(data);
            }
        });
    }
    ////////////////////////////
    deleteStudy(studyId, callback) {
        let data = {};
        $.ajax({
            url: this.submittedStudiesDetailsUrl + "/" + studyId,
            type: "DELETE",
            error(jqXhr, textStatus, errorThrown) {
                data.status = ProcessStatus.Error;
                data.message = jqXhr.responseText;
                callback(data);
            },
            success(result, textStatus, jqXhr) {
                data.status = ProcessStatus.Success;
                callback(data);
            }
        });
    }
    ////////////////////////////
    deleteSeries(seriesId, callback) {
        let data = {};
        $.ajax({
            url: this.submittedSeriesDetailsUrl + "/" + seriesId,
            type: "DELETE",
            error(jqXhr, textStatus, errorThrown) {
                data.status = ProcessStatus.Error;
                data.message = jqXhr.responseText;
                callback(data);
            },
            success(result, textStatus, jqXhr) {
                data.status = ProcessStatus.Success;
                callback(data);
            }
        });
    }
    ////////////////////////////
    getSeriesDetails(parameters, callback) {
        parameters = this.arrayOfNameValueToDictionary(parameters);
        $.ajax({
            url: this.submittedSeriesDetailsUrl + "?" + $.param(parameters),
            type: "GET",
            dataType: "json",
            error(jqXhr, textStatus, errorThrown) {
                let data = {};
                data.status = ProcessStatus.Error;
                data.message = jqXhr.responseText;
                callback(data);
            },
            success(data, textStatus, jqXhr) {
                data.status = ProcessStatus.Success;
                callback(data);
            }
        });
    }
    ///////////////////////////
    getFileListByStudyId(studyId, callback) {
        const parameters = {};
        if (studyId !== undefined) {
            parameters["DicomDataStudyID"] = studyId;
        }
        parameters["ParentLevel"] = "Study";
        $.ajax({
            url: this.submittedFilesDetailsUrl + "?" + $.param(parameters),
            type: "GET",
            dataType: 'json',
            error(jqXhr, textStatus, errorThrown) {
                let data = {};
                data.status = ProcessStatus.Error;
                data.message = jqXhr.responseText;
                callback(data);
            },
            success(data, textStatus, jqXhr) {
                data.status = ProcessStatus.Success;
                callback(data);
            }
        });
    }
    ////////////////////////////
    openViewer(parameters, callback) {
        let data = {};
        $.ajax({
            url: this.dicomViewerUrl,
            type: "PUT",
            contentType: "application/json; charset=utf-8",
            data: JSON.stringify(parameters),
            error(jqXhr, textStatus, errorThrown) {
                data.status = ProcessStatus.Error;
                data.message = jqXhr.responseText;
                callback(data);
            },
            success(result, textStatus, jqXhr) {
                const url = jqXhr.getResponseHeader("Location");
                var newwindow = window.open(url, 'temp window to test Claron integration', 'left=(screen.width/2)-400,top=(screen.height/2) - 180,width=800,height=360,toolbar=1,location =1,resizable=1,fullscreen=0');
                newwindow.focus();
                data.status = ProcessStatus.Success;
                callback(data);
            }
        });
    }
    ////////////////////////////
    downloadFile(id, callback) {
        const self = this;
        let data = {};
        $.ajax({
            url: this.submittedFilesDetailsUrl + "/" + id + "/downloadUrl",
            type: "GET",
            error(jqXhr, textStatus, errorThrown) {
                data.status = ProcessStatus.Error;
                data.message = jqXhr.responseText;
                callback(data);
            },
            success(result, text, jqXhr) {
                const uri = jqXhr.getResponseHeader("Location");
                window.location.href = self.submittedFilesDetailsUrl + "/" + uri;
                data.status = ProcessStatus.Success;
                callback(data);
            }
        });
    }
    /////////////////////////////
    deleteFile(id, callback) {
        let data = {};
        $.ajax({
            url: this.submittedFilesDetailsUrl + "/" + id,
            type: "DELETE",
            error(jqXhr, textStatus, errorThrown) {
                data.status = ProcessStatus.Error;
                data.message = jqXhr.responseText;
                callback(data);
            },
            success(result, text, jqXhr) {
                data.status = ProcessStatus.Success;
                callback(data);
            }
        });
    }
    ////////////////////////////
    getAnonymizationProfile(parameters, callback) {
        parameters = this.arrayOfNameValueToDictionary(parameters);
        $.ajax({
            url: this.anonymizationProfileUrl + "?" + $.param(parameters),
            type: "GET",
            dataType: 'json',
            error(jqXhr, textStatus, errorThrown) {
                let data = {};
                data.status = ProcessStatus.Error;
                data.message = jqXhr.responseText;
                callback(data);
            },
            success(result, textStatus, jqXhr) {
                let data = {
                    message: result,
                    status: ProcessStatus.Success
                };
                callback(data);
            }
        });
    }
    ///////////////////////////////////////////////////////////////////////////////////
    deleteFileFromStage(file) {
        var callback = file.cancelUploadFileProgress;
        var data = {};
        data.listOfFilesId = file.listOfFilesId;
        $.ajax({
            url: this.fileApiUrl + "/" + file.uri,
            type: "DELETE",
            error(jqXhr, textStatus, errorThrown) {
                data.status = ProcessStatus.Error;
                data.message = "ERROR CANCEL UPLOAD FILE";
                data.details = jqXhr.responseText;
                data.errorCode = jqXhr.status;
                callback(data);
            },
            success(result, textStatus, jqXhr) {
                data.status = ProcessStatus.Success;
                data.progress = 0;
                data.progressBytes = 0;
                data.message = "CANCEL UPLOAD FILE";
                callback(data);
            }
        });
    }
    ////////////////////////////
    uploadFile(file, uploadFileProgress) {
        var self = this;
        var data = {};
        data.file = file;
        self.setFileStatus(file, FileStatus.Uploading);
        var numberOfChunks = Math.ceil(file.size / this.settings.sizeChunk);
        var start = this.settings.sizeChunk;
        var end = start + this.settings.sizeChunk;
        var numberOfSuccessfulUploadedChunks = 0;
        var numberOfUploadedBytes = 0;
        var pendingRequests = 0;
        var fileUri;
        createFileResource(createFileResourceProgress);
        function createFileResource(callback) {
            var chunk = file.slice(0, self.settings.sizeChunk);
            const formData = new FormData();
            formData.append("chunk", chunk, file.name);
            $.ajax({
                url: self.fileApiUrl,
                type: "PUT",
                contentType: false,
                processData: false,
                data: formData,
                error(jqXhr) {
                    data.status = ProcessStatus.Error;
                    data.message = "File is not uploaded";
                    data.details = jqXhr.responseText;
                    uploadFileProgress(data);
                },
                success(result, textStatus, jqXhr) {
                    data.blockSize = chunk.size;
                    numberOfUploadedBytes += chunk.size;
                    callback(jqXhr);
                }
            });
        }
        ;
        function createFileResourceProgress(jqXhr) {
            numberOfSuccessfulUploadedChunks++;
            fileUri = jqXhr.getResponseHeader("Location");
            file.uri = fileUri;
            data.fileUri = fileUri;
            if (numberOfChunks === 1) {
                self.setFileStatus(file, FileStatus.Uploaded);
                if (self.listsOfFiles[file.listOfFilesId].isCanceled) {
                    file.cancelUploadFileProgress = uploadFileProgress;
                    self.deleteFileFromStage(file);
                }
                data.status = ProcessStatus.Success;
                data.message = "File is uploaded";
                data.progress = 100;
                data.progressBytes = numberOfUploadedBytes;
                uploadFileProgress(data);
                return;
            }
            self.setFileStatus(file, FileStatus.Uploading);
            data.status = ProcessStatus.InProgress;
            data.message = "File is uploading";
            data.progress = Math.ceil(numberOfUploadedBytes / file.size * 100);
            data.progressBytes = numberOfUploadedBytes;
            uploadFileProgress(data);
            for (let i = 2; i <= self.settings.numberOfConnection + 1; i++) {
                if (start >= file.size)
                    return;
                sendChunk(start, end, i);
                start = i * self.settings.sizeChunk;
                end = start + self.settings.sizeChunk;
            }
        }
        ;
        function sendChunk(start, end, chunkNumber) {
            if (!addRequest()) {
                return;
            }
            pendingRequests++;
            var chunk = file.slice(start, end);
            const formData = new FormData();
            formData.append("chunkOffset", start);
            formData.append("chunk", chunk, file.name);
            $.ajax({
                url: self.fileApiUrl + "/" + fileUri,
                data: formData,
                contentType: false,
                processData: false,
                type: "POST",
                error(jqXhr) {
                    pendingRequests--;
                    self.setFileStatus(file, FileStatus.UploadError);
                    data.status = ProcessStatus.Error;
                    data.message = "File is not uploaded";
                    data.details = jqXhr.responseText;
                    uploadFileProgress(data);
                },
                success(result, textStatus, jqXhr) {
                    pendingRequests--;
                    data.blockSize = chunk.size;
                    numberOfUploadedBytes += chunk.size;
                    uploadHandler(jqXhr, chunkNumber);
                }
            });
        }
        ;
        function uploadHandler(jqXhr, chunkNumber) {
            numberOfSuccessfulUploadedChunks++;
            if (numberOfSuccessfulUploadedChunks === numberOfChunks) {
                self.setFileStatus(file, FileStatus.Uploaded);
                if (self.listsOfFiles[file.listOfFilesId].isCanceled) {
                    file.cancelUploadFileProgress = uploadFileProgress;
                    self.deleteFileFromStage(file);
                }
                data.message = "File is uploaded";
                data.status = ProcessStatus.Success;
                data.progress = 100;
                data.progressBytes = numberOfUploadedBytes;
                uploadFileProgress(data);
                return;
            }
            data.status = ProcessStatus.InProgress;
            data.message = "File is uploading";
            data.progress = Math.ceil(numberOfUploadedBytes / file.size * 100);
            data.progressBytes = numberOfUploadedBytes;
            uploadFileProgress(data);
            chunkNumber += self.settings.numberOfConnection;
            if (chunkNumber > numberOfChunks)
                return;
            start = (chunkNumber - 1) * self.settings.sizeChunk;
            end = start + self.settings.sizeChunk;
            sendChunk(start, end, chunkNumber);
        }
        function addRequest() {
            if (!self.listsOfFiles[file.listOfFilesId].isCanceled)
                return true;
            if (pendingRequests === 0) {
                file.cancelUploadFileProgress = uploadFileProgress;
                console.log("addRequest delete");
                self.deleteFileFromStage(file);
            }
            return false;
        }
    }
    ////////////////////////////
    getGuid() {
        function s4() {
            return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
        }
        return (s4() + s4() + "-" + s4() + "-4" + s4().substr(0, 3) +
            "-" + s4() + "-" + s4() + s4() + s4()).toLowerCase();
    }
    ////////////////////////////
    setFileStatus(file, status) {
        file.status = status;
        switch (status) {
            case FileStatus.Ready:
                break;
            case FileStatus.Uploading:
                break;
            case FileStatus.Uploaded:
                break;
            case FileStatus.UploadError:
                break;
            case FileStatus.Canceling:
                break;
            case FileStatus.Canceled:
                break;
            case FileStatus.CancelError:
                break;
            default:
                break;
        }
    }
    ////////////////////////////
    getSizeOfListFiles(list) {
        let size = 0;
        for (let i = 0; i < list.length; i++) {
            size += list[i].size;
        }
        return size;
    }
    ////////////////////////////
    isDicom(file) {
        var deferred = $.Deferred();
        var chunk = file.slice(128, 132);
        var reader = new FileReader();
        reader.onload = () => {
            var blob = reader.result;
            var byteArray = new Uint8Array(blob);
            var result = "";
            var byte;
            for (var i = 0; i < 4; i++) {
                byte = byteArray[i];
                if (byte === 0) {
                    break;
                }
                result += String.fromCharCode(byte);
            }
            if (result !== "DICM") {
                deferred.resolve(false);
            }
            else {
                deferred.resolve(true);
            }
        };
        reader.readAsArrayBuffer(chunk);
        return deferred.promise();
    }
    arrayOfNameValueToDictionary(data) {
        var result = {};
        for (let i = 0; i < data.length; i++) {
            result[data[i].Name] = data[i].Value;
        }
        return result;
    }
}
////////////////////////////////////////////////////////////////////////////////////
class ListOfFilesForUpload {
}
class PackageOfFilesForUpload {
}
class SubmissionPackageData {
    constructor(fileUris, metadata) {
        this.FileUris = fileUris;
        this.Metadata = metadata;
    }
}
class ItemData {
    constructor(name, value) {
        this.Name = name;
        this.Value = value;
    }
}
var FileStatus;
(function (FileStatus) {
    FileStatus[FileStatus["Ready"] = 0] = "Ready";
    FileStatus[FileStatus["Uploading"] = 1] = "Uploading";
    FileStatus[FileStatus["Uploaded"] = 2] = "Uploaded";
    FileStatus[FileStatus["UploadError"] = 3] = "UploadError";
    FileStatus[FileStatus["Canceling"] = 4] = "Canceling";
    FileStatus[FileStatus["Canceled"] = 5] = "Canceled";
    FileStatus[FileStatus["CancelError"] = 6] = "CancelError";
})(FileStatus || (FileStatus = {}));
var TypeOfSubmit;
(function (TypeOfSubmit) {
    TypeOfSubmit[TypeOfSubmit["CreateSubmissionPackage"] = 0] = "CreateSubmissionPackage";
    TypeOfSubmit[TypeOfSubmit["AddDicomFilesToExistingSubmissionPackage"] = 1] = "AddDicomFilesToExistingSubmissionPackage";
    TypeOfSubmit[TypeOfSubmit["AddNonDicomFilesToExistingSubmissionPackage"] = 2] = "AddNonDicomFilesToExistingSubmissionPackage";
})(TypeOfSubmit || (TypeOfSubmit = {}));
var ProcessStatus;
(function (ProcessStatus) {
    ProcessStatus[ProcessStatus["InProgress"] = 0] = "InProgress";
    ProcessStatus[ProcessStatus["Success"] = 1] = "Success";
    ProcessStatus[ProcessStatus["Error"] = 2] = "Error";
})(ProcessStatus || (ProcessStatus = {}));
//# sourceMappingURL=webTriadService.js.map