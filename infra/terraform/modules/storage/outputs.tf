output "bucket_names" {
  value = { for kind, bucket in aws_s3_bucket.this : kind => bucket.id }
}

output "bucket_arns" {
  value = { for kind, bucket in aws_s3_bucket.this : kind => bucket.arn }
}

output "kms_key_arn" {
  value = aws_kms_key.data.arn
}
